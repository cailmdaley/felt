package shuttlecli

import (
	"github.com/cailmdaley/felt/internal/felt"
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
		return nil, nil, felt.Ref{}, err
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
