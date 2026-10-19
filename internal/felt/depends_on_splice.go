package felt

import (
	"fmt"
	"strings"
)

// SpliceOutOfQueues takes target out of every `depends_on` chain in the store.
//
// A `depends_on` edge says "this comes after that". Taking a fiber out of the
// chain closes the gap: each fiber that names target takes target's own
// dependencies in its place (A←T←B becomes A←B; a T with no dependencies
// leaves B with none), and target loses its own `depends_on`. Dependents are
// rewritten and written here; target is changed in memory only, so the
// caller's write of target carries the removal together with whatever else
// that write changes.
//
// Entries a dependent holds besides target keep their spelling. Replacements
// are written as canonical fiber ids. A dependent never ends up naming itself,
// and a list that shrinks to one entry is written as a scalar. It returns the
// ids of the dependents it rewrote.
func (s *Storage) SpliceOutOfQueues(target *Felt) ([]string, error) {
	targetNode := extraFieldNode(target.ExtraFields, "depends_on")
	all, err := s.ListMetadata()
	if err != nil {
		return nil, fmt.Errorf("listing fibers: %w", err)
	}
	ids := make([]string, 0, len(all))
	byUID := make(map[string]string, len(all))
	for _, f := range all {
		ids = append(ids, f.ID)
		if f.UID != "" {
			byUID[strings.ToLower(f.UID)] = f.ID
		}
	}
	resolver := newScopedIDResolverIn(ids, s.ExternalRefs())
	resolve := func(scopeID, ref string) (string, bool) {
		if id, err := resolver.Resolve(scopeID, ref); err == nil {
			return id, true
		}
		if LooksLikeUID(ref) {
			id, ok := byUID[strings.ToLower(ref)]
			return id, ok
		}
		return "", false
	}

	var replacement []string
	if targetNode != nil {
		refs, _ := dependsOnEntries(targetNode)
		for _, ref := range refs {
			if id, ok := resolve(target.ID, ref); ok {
				replacement = append(replacement, id)
			} else {
				replacement = append(replacement, ref)
			}
		}
	}

	var rewritten []string
	for _, meta := range all {
		if meta.ID == target.ID {
			continue
		}
		node := extraFieldNode(meta.ExtraFields, "depends_on")
		if node == nil {
			continue
		}
		refs, _ := dependsOnEntries(node)
		names := false
		for _, ref := range refs {
			if id, ok := resolve(meta.ID, ref); ok && id == target.ID {
				names = true
				break
			}
		}
		if !names {
			continue
		}
		var next []string
		seen := map[string]bool{}
		add := func(ref string) {
			key := ref
			if id, ok := resolve(meta.ID, ref); ok {
				if id == meta.ID {
					return
				}
				key = id
			}
			if seen[key] {
				return
			}
			seen[key] = true
			next = append(next, ref)
		}
		for _, ref := range refs {
			if id, ok := resolve(meta.ID, ref); ok && id == target.ID {
				for _, r := range replacement {
					add(r)
				}
				continue
			}
			add(ref)
		}
		full, err := s.Read(meta.ID)
		if err != nil {
			return rewritten, fmt.Errorf("reading %s: %w", meta.ID, err)
		}
		var value any
		switch len(next) {
		case 0:
			value = nil
		case 1:
			value = next[0]
		default:
			value = next
		}
		if err := full.SetExtraField("depends_on", value); err != nil {
			return rewritten, err
		}
		if err := s.Write(full); err != nil {
			return rewritten, fmt.Errorf("writing %s: %w", meta.ID, err)
		}
		rewritten = append(rewritten, meta.ID)
	}

	if targetNode != nil {
		if err := target.SetExtraField("depends_on", nil); err != nil {
			return rewritten, err
		}
	}
	return rewritten, nil
}
