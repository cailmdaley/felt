package felt

import (
	"sort"
	"strings"
)

// ScanCitations answers a targeted reverse-reference query directly from the
// markdown source of truth. It is intentionally independent of the SQLite
// index so explicit `show --citations` reads stay fresh without taking an
// index write lock or synchronizing unrelated fibers.
func (s *Storage) ScanCitations(targetID string) ([]Citation, error) {
	felts, err := s.List()
	if err != nil {
		return nil, err
	}
	return CitationsFromFelts(felts, targetID), nil
}

// ScanConsumers answers a targeted reverse data-flow query directly from the
// markdown source of truth. See ScanCitations for the performance contract.
func (s *Storage) ScanConsumers(targetID string) ([]DataFlowConsumer, error) {
	felts, err := s.List()
	if err != nil {
		return nil, err
	}
	return ConsumersFromFelts(felts, targetID), nil
}

func CitationsFromFelts(felts []*Felt, targetID string) []Citation {
	ids := sortedFeltIDs(felts)
	var citations []Citation
	for _, f := range felts {
		for _, ref := range ExtractBodyRefs(f.Body) {
			resolved, err := ResolveScopedID(ids, f.ID, ref.Target)
			if err != nil || resolved != targetID {
				continue
			}
			citations = append(citations, Citation{
				SourceID:   f.ID,
				TargetID:   resolved,
				Fragment:   ref.Fragment,
				SourceName: f.DisplayName(),
			})
		}
	}
	sort.Slice(citations, func(i, j int) bool {
		if citations[i].SourceID != citations[j].SourceID {
			return citations[i].SourceID < citations[j].SourceID
		}
		return citations[i].Fragment < citations[j].Fragment
	})
	return citations
}

func ConsumersFromFelts(felts []*Felt, targetID string) []DataFlowConsumer {
	ids := sortedFeltIDs(felts)
	var consumers []DataFlowConsumer
	for _, f := range felts {
		for _, input := range f.DataFlowInputs() {
			targetFiber, fragment := splitDataFlowRef(input.From)
			if targetFiber == "" {
				continue
			}
			resolved, err := ResolveScopedID(ids, f.ID, targetFiber)
			if err != nil || resolved != targetID {
				continue
			}
			consumers = append(consumers, DataFlowConsumer{
				SourceID:   f.ID,
				TargetID:   resolved,
				OutputID:   fragment,
				InputID:    input.InputID,
				SourceName: f.DisplayName(),
			})
		}
	}
	sort.Slice(consumers, func(i, j int) bool {
		leftOutput := strings.TrimSpace(consumers[i].OutputID)
		rightOutput := strings.TrimSpace(consumers[j].OutputID)
		if leftOutput != rightOutput {
			return leftOutput < rightOutput
		}
		if consumers[i].SourceID != consumers[j].SourceID {
			return consumers[i].SourceID < consumers[j].SourceID
		}
		return strings.TrimSpace(consumers[i].InputID) < strings.TrimSpace(consumers[j].InputID)
	})
	return consumers
}

func sortedFeltIDs(felts []*Felt) []string {
	ids := make([]string, 0, len(felts))
	for _, f := range felts {
		ids = append(ids, f.ID)
	}
	sort.Strings(ids)
	return ids
}
