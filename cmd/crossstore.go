package cmd

import (
	"path"

	"github.com/cailmdaley/felt/internal/felt"
)

// liftPair puts two refs in one store so an operation can run over both.
//
// Nesting a fiber under a parent in another project's subtree is a legitimate
// move — one loom, one git repo, one namespace — so when either side is external
// the whole operation runs in the enclosing store, with the local side
// translated into outer coordinates. When both sides are local nothing moves.
func liftPair(storage *felt.Storage, a, b felt.Ref) (string, string, felt.Ref) {
	if !a.Elsewhere && !b.Elsewhere {
		return a.ID, b.ID, felt.Ref{Storage: storage}
	}
	external := storage.ExternalRefs()
	prefix := external.Prefix()
	outer := a.Storage
	if !a.Elsewhere {
		outer = b.Storage
	}
	where := felt.Ref{Storage: outer, Elsewhere: true, EnclosingRoot: external.Root()}
	return liftID(a, prefix), liftID(b, prefix), where
}

// liftID renders a ref's id in the enclosing store's coordinates.
func liftID(ref felt.Ref, prefix string) string {
	if ref.Elsewhere {
		return ref.ID
	}
	return path.Join(prefix, ref.ID)
}
