package shuttlecli

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
	"gopkg.in/yaml.v3"
)

type statusOwnerRead struct {
	Running      bool
	Session      string
	RuntimeKnown bool
	Fiber        *felt.Felt
	Stale        bool
	Source       string
	Error        string
}

// Owner document reads are separate from local readers used by daemon polling.
func (a *app) readStatusOwner(f *felt.Felt, localFallback bool, feed *statusFeed) (statusOwnerRead, error) {
	result := statusOwnerRead{Fiber: f, Source: "local"}
	block, ok, err := shuttle.BlockOf(f)
	if err != nil {
		return result, err
	}
	if !ok {
		return result, nil
	}
	own, err := a.resolveOwnHost("")
	if err != nil {
		return result, err
	}
	if block.Host == "" || block.Host == own {
		return result, nil
	}
	id := f.UID
	if id == "" {
		id = f.ID
	}
	segments := strings.Split(id, "/")
	for i := range segments {
		segments[i] = url.PathEscape(segments[i])
	}
	endpoint, err := a.daemonEndpoint("/api/v1/fibers/" + strings.Join(segments, "/"))
	if err != nil {
		return result, err
	}
	endpoint += "?" + url.Values{"origin": {block.Host}}.Encode()
	body, err := a.getDaemon(endpoint, daemonReadTimeout)
	if err != nil {
		if localFallback && ownerReadUnavailable(err, block.Host) {
			result.Stale = true
			result.Source = "local_fallback"
			result.Error = err.Error()
			return result, nil
		}
		return result, err
	}
	var response struct {
		Fibers []struct {
			Fiber map[string]any `json:"fiber"`
		} `json:"fibers"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		return result, fmt.Errorf("decoding owner %s: %w", block.Host, err)
	}
	if len(response.Fibers) != 1 {
		return result, fmt.Errorf("owner %s returned %d fibers for %s", block.Host, len(response.Fibers), id)
	}
	remote, err := statusDocument(response.Fibers[0].Fiber)
	if err != nil {
		return result, err
	}
	remoteBlock, ok, err := shuttle.BlockOf(remote)
	if err != nil || !ok || remoteBlock.Host != block.Host {
		return result, fmt.Errorf("owner %s returned an unverified document for %s", block.Host, id)
	}
	if f.UID != "" && !remote.MatchesUID(f.UID) {
		return result, fmt.Errorf("owner %s returned a different UID for %s", block.Host, id)
	}
	result.Fiber = remote
	result.Source = "owner"
	if feed == nil {
		feed, _ = a.fetchStatusFeed()
	}
	if feed != nil {
		origin, known := feed.Origins[block.Host]
		if known && !origin.Stale && (origin.Cache.State == "" || origin.Cache.State == "fresh") {
			result.RuntimeKnown = true
			for _, row := range feed.Fibers {
				if row.Origin == block.Host && (row.Fiber["uid"] == remote.UID || row.Fiber["id"] == remote.UID || row.Fiber["slug"] == remote.ID) {
					result.Running = len(row.Runtime) > 0
					result.Session, _ = row.Runtime["tmux_session"].(string)
					break
				}
			}
		}
	}
	return result, nil
}

func ownerReadUnavailable(err error, owner string) bool {
	if isLifecycleTransportError(err) || strings.Contains(err.Error(), "reading daemon response") {
		return true
	}
	if _, ok := ownerForwardFailure(err, owner); ok {
		return true
	}
	var status daemonStatusError
	return errors.As(err, &status) && (status.status == 502 || status.status == 503 || status.status == 504)
}

func statusDocument(data map[string]any) (*felt.Felt, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	f := &felt.Felt{}
	if err := json.Unmarshal(raw, f); err != nil {
		return nil, fmt.Errorf("decoding owner document: %w", err)
	}
	if f.UID == "" && felt.LooksLikeUID(f.ID) {
		f.UID = f.ID
	}
	if slug, ok := data["slug"].(string); ok && slug != "" {
		f.ID = slug
	}
	f.ExtraFields = map[string]*yaml.Node{}
	for key, value := range data {
		if felt.IsNativeFrontmatterKey(key) || key == "slug" || key == "uid" || key == "path" || key == "body" || key == "body_start_line" {
			continue
		}
		var node yaml.Node
		if err := node.Encode(value); err != nil {
			return nil, err
		}
		f.ExtraFields[key] = &node
		f.ExtraFieldOrder = append(f.ExtraFieldOrder, key)
	}
	return f, nil
}

func (a *app) statusRemoteRow(entry shuttleEntry, feed *statusFeed) (FiberStatus, error) {
	f := entry.Fiber
	if f != nil {
		copy := *f
		f = &copy
		f.ID = entry.FiberID
	}
	if f == nil {
		f = &felt.Felt{ID: entry.FiberID, UID: entry.UID, Status: entry.Status, ExtraFields: map[string]*yaml.Node{}}
	}
	if err := shuttle.SetConfig(f, entry.Block); err != nil {
		return FiberStatus{}, err
	}
	var read statusOwnerRead
	if origin, known := feed.Origins[entry.Block.Host]; known && !origin.Stale && (origin.Cache.State == "" || origin.Cache.State == "fresh") {
		for _, row := range feed.Fibers {
			if row.Origin == entry.Block.Host && (row.Fiber["uid"] == entry.UID || row.Fiber["id"] == entry.UID || row.Fiber["slug"] == entry.FiberID) {
				remote, err := statusDocument(row.Fiber)
				if err != nil {
					return FiberStatus{}, err
				}
				read = statusOwnerRead{Fiber: remote, Source: "owner", RuntimeKnown: true, Running: len(row.Runtime) > 0}
				read.Session, _ = row.Runtime["tmux_session"].(string)
				break
			}
		}
		// A fresh owner feed's absence overrides a lingering archive copy.
		if read.Fiber == nil {
			return FiberStatus{}, nil
		}
	} else {
		var err error
		read, err = a.readStatusOwner(f, true, feed)
		if err != nil {
			return FiberStatus{}, err
		}
	}
	block, ok, err := shuttle.BlockOf(read.Fiber)
	if err != nil {
		return FiberStatus{}, err
	}
	if !ok || block.Host != entry.Block.Host {
		return FiberStatus{}, fmt.Errorf("owner feed does not own %s", entry.FiberID)
	}
	row := FiberStatus{FiberID: read.Fiber.ID, Origin: block.Host, Kind: block.Kind, Agent: block.Agent, State: computeState(block, read.Fiber.Status, read.Running), Running: read.Running, Session: read.Session, Stale: read.Stale, Source: read.Source, ReadError: read.Error}
	if read.Fiber.Status == felt.StatusActive && !read.RuntimeKnown && !read.Stale {
		row.State = "active (worker unknown)"
	}
	if horizonStashed(read.Fiber) && !read.Running {
		row.State = "resting"
	}
	return row, nil
}

type statusFeed struct {
	Host   string `json:"host"`
	Fibers []struct {
		Origin  string         `json:"origin"`
		Fiber   map[string]any `json:"fiber"`
		Runtime map[string]any `json:"runtime"`
	} `json:"fibers"`
	Origins map[string]struct {
		Stale     bool `json:"stale"`
		LastError any  `json:"last_error"`
		Cache     struct {
			State string `json:"state"`
		} `json:"cache"`
	} `json:"origins"`
}

func (a *app) fetchStatusFeed() (*statusFeed, error) {
	endpoint, err := a.daemonEndpoint("/api/v1/fibers/composite")
	if err != nil {
		return nil, err
	}
	feed, err := getDaemonJSON[statusFeed](a, endpoint, "parsing owner status inventory")
	return &feed, err
}

// Inventory rows come from owners, including constitutions absent from this
// archive. Local mirrors are considered only for unavailable owner feeds.
func (a *app) ownerInventoryRows(only string) ([]FiberStatus, error) {
	feed, err := a.fetchStatusFeed()
	if err != nil {
		return nil, err
	}
	own, err := a.resolveOwnHost("")
	if err != nil {
		return nil, err
	}
	rows := []FiberStatus{}
	seen := map[string]bool{}
	for _, entry := range feed.Fibers {
		if only != "" && entry.Origin != only {
			continue
		}
		f, err := statusDocument(entry.Fiber)
		if err != nil {
			return nil, err
		}
		block, ok, err := shuttle.BlockOf(f)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		if block.Host != entry.Origin {
			return nil, fmt.Errorf("status inventory origin %q does not own %s", entry.Origin, f.ID)
		}
		key := entry.Origin + ":" + f.ID
		origin := entry.Origin
		if origin == own {
			origin = ""
		}
		originInfo, known := feed.Origins[entry.Origin]
		stale := !known || originInfo.Stale || (originInfo.Cache.State != "" && originInfo.Cache.State != "fresh")
		running := len(entry.Runtime) > 0 && !stale
		row := FiberStatus{FiberID: f.ID, Origin: origin, Kind: block.Kind, Agent: block.Agent, Running: running, State: computeState(block, f.Status, running), Stale: stale, Source: "owner"}
		row.Session, _ = entry.Runtime["tmux_session"].(string)
		if horizonStashed(f) && !running {
			row.State = "resting"
		}
		if stale {
			row.Source = "owner_cache"
		}
		rows = append(rows, row)
		seen[key] = true
	}
	stores, storeErr := a.shuttleStores()
	if storeErr != nil {
		return rows, nil
	}
	entries, storeErr := a.listShuttleFibersAcrossStores(stores)
	if storeErr != nil {
		return rows, nil
	}
	for _, entry := range entries {
		host := entry.Block.Host
		if host == "" || host == own || (only != "" && host != only) || seen[host+":"+entry.FiberID] {
			continue
		}
		origin, known := feed.Origins[host]
		if known && !origin.Stale && (origin.Cache.State == "" || origin.Cache.State == "fresh") {
			continue
		}
		row, err := a.statusRemoteRow(entry, feed)
		if err != nil {
			return nil, err
		}
		rows = append(rows, row)
	}
	return rows, nil
}
