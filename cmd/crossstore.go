package cmd

import (
	"fmt"
	"path"

	"github.com/cailmdaley/felt/internal/felt"
)

// Reaching across the substore boundary.
//
// A project store whose `.felt` is a symlink into a larger one is a LENS on
// that store, not a fence around it: the enclosing store is the store, and
// this view only narrows what gets listed. So an id that names a fiber out
// there is not refused — the command runs against the enclosing store, on the
// fiber where it actually lives, and says so in its output.
//
// The safety of that rests on where these refs come from. Only an id the
// ENCLOSING store resolved unambiguously arrives here: the basename rescue —
// the "your path went stale, but the slug is unique" guess — never crosses
// the boundary, because the external probe sits above it and a hit there
// returns before the guess runs (see scopedIDResolver.resolve). There is no
// path by which felt guesses at a fiber and then deletes or moves it. Keep it
// that way: anything that widens what counts as an external hit also widens
// what `rm` will delete.

// fiberRef is a resolved command argument: which store holds the fiber, and
// the id it has THERE. For a local fiber that is the store the user is
// standing in; for an external one it is the enclosing store and the id in
// outer coordinates.
type fiberRef struct {
	storage   *felt.Storage
	id        string
	elsewhere bool
	root      string // the enclosing .felt, when elsewhere
}

// location is the parenthetical a mutating command appends so a cross-store
// write is never silent: `Deleted ai-futures/portolan/debug (in /…/loom/.felt)`.
func (r fiberRef) location() string {
	if !r.elsewhere {
		return ""
	}
	return fmt.Sprintf(" (in %s)", r.root)
}

// resolveFiberRef resolves one command argument, reaching into the enclosing
// store when the local view cannot see the fiber. Metadata-only: callers that
// need the body read it from the store the ref names.
func resolveFiberRef(storage *felt.Storage, scopeID, arg string) (fiberRef, error) {
	f, err := storage.FindMetadataInScope(scopeID, arg)
	if err == nil {
		return fiberRef{storage: storage, id: f.ID}, nil
	}
	ref, ok := felt.AsExternalReference(err)
	if !ok {
		return fiberRef{}, err
	}
	outer := felt.NewStorage(ref.ProjectDir)
	outerFelt, outerErr := outer.FindMetadataInScope("", ref.ID)
	if outerErr != nil {
		// The enclosing store named it a moment ago; if it cannot produce it
		// now, report the original failure rather than a confusing second one.
		return fiberRef{}, err
	}
	return fiberRef{storage: outer, id: outerFelt.ID, elsewhere: true, root: ref.Root}, nil
}

// liftPair puts two refs in one store so an operation can run over both.
//
// Nesting a fiber under a parent in another project's subtree is a legitimate
// move — one loom, one git repo, one namespace — so when either side is
// external the whole operation runs in the enclosing store, with the local
// side translated into outer coordinates (`debug` becomes
// `ai-futures/felt/debug`). When both sides are local nothing moves.
// It returns the store the operation runs in, the two ids in that store's
// coordinates, and a ref describing WHERE that is — so the caller reports the
// crossing with the same location() suffix every other cross-store verb uses.
func liftPair(storage *felt.Storage, a, b fiberRef) (*felt.Storage, string, string, fiberRef) {
	if !a.elsewhere && !b.elsewhere {
		return storage, a.id, b.id, fiberRef{storage: storage}
	}
	external := storage.ExternalRefs()
	prefix := external.Prefix()
	outer := a.storage
	if !a.elsewhere {
		outer = b.storage
	}
	where := fiberRef{storage: outer, elsewhere: true, root: external.Root()}
	return outer, liftID(a, prefix), liftID(b, prefix), where
}

// liftID renders a ref's id in the enclosing store's coordinates.
func liftID(r fiberRef, prefix string) string {
	if r.elsewhere {
		return r.id
	}
	return path.Join(prefix, r.id)
}
