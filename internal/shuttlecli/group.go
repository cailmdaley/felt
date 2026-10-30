package shuttlecli

import (
	"encoding/json"
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
	ref, err := felt.ResolveRef(storage, felt.CommandScope(a.env, root, a.dir), query)
	if err != nil {
		remote, remoteRef, remoteErr := a.remoteFiber(query, full)
		if remoteErr != nil {
			return nil, nil, felt.Ref{}, err
		}
		return remote, nil, remoteRef, nil
	}
	var fiber *felt.Felt
	if full {
		fiber, err = ref.Storage.FindInScope("", ref.ID)
	} else {
		fiber, err = ref.Storage.FindMetadataInScope("", ref.ID)
	}
	if err != nil {
		return nil, nil, felt.Ref{}, err
	}
	return fiber, ref.Storage, ref, nil
}

// remoteFiber resolves a fiber absent from the local Git view through the
// daemon's composite owner index, then reads its current document from that
// owner. The returned storage is nil: callers must route mutations to the
// owner rather than treating the fetched document as a writable mirror.
func (a *app) remoteFiber(query string, full bool) (*felt.Felt, felt.Ref, error) {
	var row *compositeFiberRow
	for _, candidate := range a.compositeFiberRows() {
		id, _ := candidate.Fiber["id"].(string)
		slug, _ := candidate.Fiber["slug"].(string)
		if candidate.Origin != "" && (candidate.Path == query || id == query || slug == query) {
			copy := candidate
			row = &copy
			break
		}
	}
	if row == nil {
		return nil, felt.Ref{}, fmt.Errorf("fiber %s is not in the local store or daemon index", query)
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
