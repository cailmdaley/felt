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

// Ref edge-kind discriminants, matching the link table's edge_type values.
const (
	refKindReference = "reference"
	refKindDataFlow  = "data_flow"
)

// resolvedRef is one outbound reference from a source fiber after scope
// resolution. It carries BOTH outcomes: ResolvedID is set when resolution
// succeeded, ResolveErr is set otherwise (the index acts on the unresolved
// branch via insertRawRef, and check emits a broken-ref issue on it). The
// fields are sufficient to reconstruct every site-specific need without a
// second pass over the source.
type resolvedRef struct {
	Source    *Felt
	Kind      string // refKindReference | refKindDataFlow
	RawTarget string // body ref target, or the data-flow target fiber
	Fragment  string
	InputID   string // data-flow input id; empty for body refs
	// Label is the human-facing reference rendering used in broken-ref
	// messages: BodyRef.String() for references, and the data-flow source
	// spelling (full `input.From` when it carries a fragment, else the bare
	// target fiber) for data-flow refs.
	Label      string
	ResolvedID string
	ResolveErr error
}

// iterRefs walks every outbound reference (body references then data-flow
// inputs) of each felt in document order, resolving each against ids and
// invoking yield once per ref. Empty/blank data-flow targets are skipped
// before yielding — matching every existing call site. Resolution uses the
// per-ref ResolveScopedID free function, preserving prior semantics exactly.
// A non-nil yield error halts iteration and propagates (the index path needs
// this; the read-only consumers/check paths always return nil).
func iterRefs(felts []*Felt, ids []string, yield func(resolvedRef) error) error {
	for _, f := range felts {
		for _, ref := range ExtractBodyRefs(f.Body) {
			resolved, err := ResolveScopedID(ids, f.ID, ref.Target)
			if err := yield(resolvedRef{
				Source:     f,
				Kind:       refKindReference,
				RawTarget:  ref.Target,
				Fragment:   ref.Fragment,
				Label:      ref.String(),
				ResolvedID: resolved,
				ResolveErr: err,
			}); err != nil {
				return err
			}
		}
		for _, input := range f.DataFlowInputs() {
			targetFiber, fragment := splitDataFlowRef(input.From)
			if targetFiber == "" {
				continue
			}
			label := targetFiber
			if strings.TrimSpace(fragment) != "" {
				label = input.From
			}
			resolved, err := ResolveScopedID(ids, f.ID, targetFiber)
			if err := yield(resolvedRef{
				Source:     f,
				Kind:       refKindDataFlow,
				RawTarget:  targetFiber,
				Fragment:   fragment,
				InputID:    input.InputID,
				Label:      label,
				ResolvedID: resolved,
				ResolveErr: err,
			}); err != nil {
				return err
			}
		}
	}
	return nil
}

func CitationsFromFelts(felts []*Felt, targetID string) []Citation {
	ids := sortedFeltIDs(felts)
	var citations []Citation
	_ = iterRefs(felts, ids, func(r resolvedRef) error {
		if r.Kind != refKindReference || r.ResolveErr != nil || r.ResolvedID != targetID {
			return nil
		}
		citations = append(citations, Citation{
			SourceID:   r.Source.ID,
			TargetID:   r.ResolvedID,
			Fragment:   r.Fragment,
			SourceName: r.Source.DisplayName(),
		})
		return nil
	})
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
	_ = iterRefs(felts, ids, func(r resolvedRef) error {
		if r.Kind != refKindDataFlow || r.ResolveErr != nil || r.ResolvedID != targetID {
			return nil
		}
		consumers = append(consumers, DataFlowConsumer{
			SourceID:   r.Source.ID,
			TargetID:   r.ResolvedID,
			OutputID:   r.Fragment,
			InputID:    r.InputID,
			SourceName: r.Source.DisplayName(),
		})
		return nil
	})
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
