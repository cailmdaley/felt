package felt

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path"
)

// ReferenceChange describes a reference whose resolved target changes when ids
// are introduced. Before and After name fibers, or the resolution failure.
type ReferenceChange struct {
	SourceID string
	Label    string
	Before   string
	After    string
}

func resolutionTarget(id string, err error) string {
	if ref, ok := AsExternalReference(err); ok {
		return ref.ID + " (enclosing store)"
	}
	if err != nil {
		return err.Error()
	}
	return id
}

// referenceChanges compares the references among felts whose final segment
// matches the new id's against the id sets before and after its creation.
func referenceChanges(felts []*Felt, beforeIDs []string, id string, external *ExternalRefs, absent map[string]int) []ReferenceChange {
	base := path.Base(id)
	before := newScopedIDResolverIn(beforeIDs, external, absent)
	after := newScopedIDResolverIn(append(append([]string{}, beforeIDs...), id), external, absent)
	var changes []ReferenceChange
	seen := map[string]bool{}
	for _, f := range felts {
		visit := func(target, label string) {
			if path.Base(cleanLookupID(target)) != base {
				return
			}
			old, _, oldErr := before.resolve(f.ID, target)
			if oldErr != nil && !errors.Is(oldErr, ErrExternalReference) {
				return
			}
			source := f.ID
			next, _, nextErr := after.resolve(source, target)
			oldResult, nextResult := resolutionTarget(old, oldErr), resolutionTarget(next, nextErr)
			if oldResult == nextResult {
				return
			}
			key := fmt.Sprintf("%s\x00%s", source, label)
			if seen[key] {
				return
			}
			seen[key] = true
			changes = append(changes, ReferenceChange{SourceID: source, Label: label, Before: oldResult, After: nextResult})
		}
		for _, site := range bodyRefSites(f.Body) {
			visit(site.ref.Target, site.label)
		}
		for _, input := range f.DataFlowInputs() {
			target, _ := splitDataFlowRef(input.From)
			visit(target, input.From)
		}
	}
	return changes
}

// CreationReferenceChanges reports the effects of adding id to this store.
func (s *Storage) CreationReferenceChanges(id string) ([]ReferenceChange, error) {
	files, err := s.listFiberFiles()
	if err != nil {
		return nil, err
	}
	ids := make([]string, len(files))
	for i, file := range files {
		ids[i] = file.id
	}
	candidates := make([]*Felt, len(files))
	failures := make([]error, len(files))
	needle := []byte(path.Base(id))
	parallelFileWork(len(files), func(i int) {
		file := files[i]
		data, err := os.ReadFile(file.path)
		if err != nil {
			failures[i] = err
			return
		}
		if !bytes.Contains(data, needle) {
			return
		}
		candidates[i], failures[i] = Parse(file.id, data)
	})
	var felts []*Felt
	for _, f := range candidates {
		if f != nil {
			felts = append(felts, f)
		}
	}
	absent, err := s.AbsentNeighbors()
	if err != nil {
		return nil, errors.Join(append(failures, err)...)
	}
	return referenceChanges(felts, ids, id, s.ExternalRefs(), absent), errors.Join(failures...)
}
