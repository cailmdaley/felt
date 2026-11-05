package shuttlecli

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"gopkg.in/yaml.v3"
)

// shuttleResolveFiber resolves a fiber id or path in the selected store. Full
// reads preserve the body for write operations; metadata-only reads serve
// address and status lookups.
func (a *app) shuttleResolveFiber(query string, full bool) (*felt.Felt, *felt.Storage, error) {
	f, storage, _, err := a.shuttleResolveFiberRef(query, full)
	return f, storage, err
}

func (a *app) shuttleResolveFiberRef(query string, full bool) (*felt.Felt, *felt.Storage, felt.Ref, error) {
	root, err := felt.ProjectRoot(a.env, a.dir)
	if err != nil {
		return nil, nil, felt.Ref{}, err
	}
	storage := felt.NewStorage(root)
	var ref felt.Ref
	if a.fiberPathHint != "" {
		ref, err = felt.ResolveAddressRefWithHint(storage, query, a.fiberPathHint)
	} else {
		ref, err = felt.ResolveRef(storage, felt.CommandScope(a.env, root, a.dir), query)
	}
	if err != nil {
		// Interactive misses can ask an owner. Exact writer addresses remain
		// local; ambiguity and read failures never become another lookup.
		if _, missing := err.(*felt.NoFiberMatchError); !missing || a.fiberPathHint != "" {
			return nil, nil, felt.Ref{}, err
		}
		remote, remoteRef, remoteErr := a.remoteFiber(query, full)
		if remoteErr != nil {
			if errors.Is(remoteErr, errNoRemoteFiber) {
				return nil, nil, felt.Ref{}, err
			}
			return nil, nil, felt.Ref{}, fmt.Errorf("%v; owner lookup: %w", err, remoteErr)
		}
		return remote, nil, remoteRef, nil
	}
	mode := felt.ParseMetadataOnly
	if full {
		mode = felt.ParseFull
	}
	fiber, err := felt.ReadRef(ref, mode)
	if err != nil {
		return nil, nil, felt.Ref{}, err
	}
	return fiber, ref.Storage, ref, nil
}

var errNoRemoteFiber = errors.New("no matching owner fiber")
var errAmbiguousOwner = errors.New("ambiguous owner address")

// remoteFiberRow resolves an exact identifier from the owner's metadata,
// without opening either host's document.
func (a *app) remoteFiberRow(query string) (*compositeFiberRow, error) {
	endpoint, err := a.daemonEndpoint("/api/v1/fibers/composite")
	if err != nil {
		return nil, err
	}
	index, err := getDaemonJSON[struct {
		Fibers []compositeFiberRow `json:"fibers"`
	}](a, endpoint, "parsing composite fibers")
	if err != nil {
		return nil, err
	}
	var row *compositeFiberRow
	for _, candidate := range index.Fibers {
		id, _ := candidate.Fiber["id"].(string)
		slug, _ := candidate.Fiber["slug"].(string)
		uid, _ := candidate.Fiber["uid"].(string)
		if candidate.Origin != "" && (candidate.Path == query || id == query || slug == query || uid == query) {
			if row != nil {
				return nil, fmt.Errorf("%w: fiber %q is ambiguous across owners %q and %q; use its intrinsic UID", errAmbiguousOwner, query, row.Origin, candidate.Origin)
			}
			copy := candidate
			row = &copy
		}
	}
	if row == nil {
		return nil, errNoRemoteFiber
	}
	return row, nil
}

// remoteFiber reads the current owner document. Its storage-less result is
// addressable through the owner, never writable as a local mirror.
func (a *app) remoteFiber(query string, full bool) (*felt.Felt, felt.Ref, error) {
	row, err := a.remoteFiberRow(query)
	if err != nil {
		return nil, felt.Ref{}, err
	}
	id, _ := row.Fiber["slug"].(string)
	if id == "" {
		return nil, felt.Ref{}, fmt.Errorf("daemon index has no path for %s", query)
	}
	segments := strings.Split(id, "/")
	for i := range segments {
		segments[i] = url.PathEscape(segments[i])
	}
	endpoint, err := a.daemonEndpoint("/api/v1/fibers/" + strings.Join(segments, "/"))
	if err != nil {
		return nil, felt.Ref{}, err
	}
	queryValues := url.Values{"origin": {row.Origin}, "body": {fmt.Sprint(full)}}
	endpoint += "?" + queryValues.Encode()
	body, err := a.getDaemon(endpoint, daemonReadTimeout)
	if err != nil {
		return nil, felt.Ref{}, err
	}
	var response struct {
		Fibers []struct {
			Fiber map[string]any `json:"fiber"`
		} `json:"fibers"`
	}
	if err := json.Unmarshal(body, &response); err != nil || len(response.Fibers) != 1 {
		if err == nil {
			err = fmt.Errorf("got %d fibers", len(response.Fibers))
		}
		return nil, felt.Ref{}, fmt.Errorf("parsing owner fiber %s: %w", id, err)
	}
	data := response.Fibers[0].Fiber
	rawFiber, _ := json.Marshal(data)
	f := &felt.Felt{}
	if err := json.Unmarshal(rawFiber, f); err != nil {
		return nil, felt.Ref{}, fmt.Errorf("decoding owner fiber %s: %w", id, err)
	}
	if f.UID == "" {
		if value, ok := data["id"].(string); ok && value != id {
			f.UID = value
		}
	}
	f.ID = id
	// A storage-less document is safe only when every mutating caller must
	// route to a distinct owner. Hostless and local rows need local storage.
	blockData, _ := data["shuttle"].(map[string]any)
	owner, _ := blockData["host"].(string)
	own, err := a.resolveOwnHost("")
	if err != nil {
		return nil, felt.Ref{}, err
	}
	if owner == "" || owner == own || owner != row.Origin {
		return nil, felt.Ref{}, fmt.Errorf("fiber %q has no verified remote owner (origin %q, host %q)", query, row.Origin, owner)
	}
	if f.UID == "" {
		return nil, felt.Ref{}, fmt.Errorf("owner %q returned no intrinsic UID for %s", owner, id)
	}
	f.ExtraFields = make(map[string]*yaml.Node)
	for key, value := range data {
		if felt.IsNativeFrontmatterKey(key) || key == "slug" || key == "path" || key == "body" || key == "body_start_line" {
			continue
		}
		raw, err := yaml.Marshal(map[string]any{key: value})
		if err != nil {
			continue
		}
		var document yaml.Node
		if yaml.Unmarshal(raw, &document) == nil && len(document.Content) > 0 {
			mapping := document.Content[0]
			if mapping.Kind == yaml.MappingNode && len(mapping.Content) >= 2 {
				f.ExtraFields[key] = mapping.Content[1]
				f.ExtraFieldOrder = append(f.ExtraFieldOrder, key)
			}
		}
	}
	return f, felt.Ref{ID: id, UID: f.UID}, nil
}
