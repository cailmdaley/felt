package felt

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path"
	"strings"
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

// ReferenceChanges compares references with a matching final segment against
// the id sets on either side of a creation or move. sourceID maps a source's
// address into the new set; nil leaves sources in place.
func ReferenceChanges(felts []*Felt, beforeIDs, afterIDs, introduced []string, external *ExternalRefs, sourceID func(string) string, absent ...map[string]int) []ReferenceChange {
	bases := map[string]bool{}
	for _, id := range introduced {
		bases[path.Base(id)] = true
	}
	before := newScopedIDResolverIn(beforeIDs, external, absent...)
	after := newScopedIDResolverIn(afterIDs, external, absent...)
	var changes []ReferenceChange
	seen := map[string]bool{}
	for _, f := range felts {
		visit := func(target, label string) {
			if !bases[path.Base(cleanLookupID(target))] {
				return
			}
			old, _, oldErr := before.resolve(f.ID, target)
			if oldErr != nil && !errors.Is(oldErr, ErrExternalReference) {
				return
			}
			// Moves rewrite references to moved targets to preserve their identity.
			if sourceID != nil && oldErr == nil && sourceID(old) != old {
				return
			}
			source := f.ID
			if sourceID != nil {
				source = sourceID(source)
			}
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
	changes, err := s.creationReferenceChanges(id, "")
	if external := s.ExternalRefs(); external != nil {
		outer := &Storage{root: external.Root()}
		outside, outsideErr := outer.creationReferenceChanges(path.Join(external.Prefix(), id), external.Prefix())
		changes = append(changes, outside...)
		err = errors.Join(err, outsideErr)
	}
	return changes, err
}

func (s *Storage) creationReferenceChanges(id, excludePrefix string) ([]ReferenceChange, error) {
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
		if excludePrefix != "" && (file.id == excludePrefix || strings.HasPrefix(file.id, excludePrefix+"/")) {
			return
		}
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
	return ReferenceChanges(felts, ids, append(append([]string{}, ids...), id), []string{id}, s.ExternalRefs(), nil, absent), errors.Join(failures...)
}
