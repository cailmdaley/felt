package felt

import (
	"sort"
	"strings"
)

// Citation is a resolved wikilink from one fiber to another — a narrative
// reference surfaced under `show --citations`.
type Citation struct {
	SourceID   string
	TargetID   string
	Fragment   string
	SourceName string
}

// DataFlowConsumer is a fiber that names another as a data-flow input via the
// `inputs.from` convention — surfaced under `show --consumers`.
type DataFlowConsumer struct {
	SourceID   string
	TargetID   string
	OutputID   string
	InputID    string
	SourceName string
}

// ScanCitations answers a targeted reverse-reference query directly from the
// markdown source of truth.
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

// ScanRelationships answers both reverse-reference queries for a target in a
// single markdown walk. Callers that need citations and consumers together
// (show -d summary/full) get one List() plus one iterRefs pass instead of the
// two the single-sided Scan* functions would cost, since iterRefs already
// yields both edge kinds.
func (s *Storage) ScanRelationships(targetID string) ([]Citation, []DataFlowConsumer, error) {
	felts, err := s.List()
	if err != nil {
		return nil, nil, err
	}
	return RelationshipsFromFelts(felts, targetID)
}

// RelationshipsFromFelts collects citations and consumers for targetID in one
// iterRefs pass, dispatching each yielded ref to the matching accumulator.
func RelationshipsFromFelts(felts []*Felt, targetID string) ([]Citation, []DataFlowConsumer, error) {
	ids := sortedFeltIDs(felts)
	var citations []Citation
	var consumers []DataFlowConsumer
	_ = iterRefs(felts, ids, func(r resolvedRef) error {
		if r.ResolveErr != nil || r.ResolvedID != targetID {
			return nil
		}
		switch r.Kind {
		case refKindReference:
			citations = append(citations, Citation{
				SourceID:   r.Source.ID,
				TargetID:   r.ResolvedID,
				Fragment:   r.Fragment,
				SourceName: r.Source.DisplayName(),
			})
		case refKindDataFlow:
			consumers = append(consumers, DataFlowConsumer{
				SourceID:   r.Source.ID,
				TargetID:   r.ResolvedID,
				OutputID:   r.Fragment,
				InputID:    r.InputID,
				SourceName: r.Source.DisplayName(),
			})
		}
		return nil
	})
	sortCitations(citations)
	sortConsumers(consumers)
	return citations, consumers, nil
}

// Ref edge-kind discriminants, matching the link table's edge_type values.
const (
	refKindReference = "reference"
	refKindDataFlow  = "data_flow"
)

// resolvedRef is one outbound reference from a source fiber after scope
// resolution. It carries BOTH outcomes: ResolvedID is set when resolution
// succeeded, ResolveErr is set otherwise (check emits a broken-ref issue on
// the unresolved branch). The fields are sufficient to reconstruct every
// site-specific need without a second pass over the source.
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
// before yielding — matching every existing call site. A non-nil yield error
// halts iteration and propagates.
//
// The resolver is built once for the whole walk rather than per-ref, since
// newScopedIDResolver rebuilds maps + sorts over every id.
func iterRefs(felts []*Felt, ids []string, yield func(resolvedRef) error) error {
	return iterRefsResolved(felts, newScopedIDResolver(ids), yield)
}

// iterRefsResolved is iterRefs against a prebuilt resolver, so a caller that
// walks many fibers against the same id set builds the resolver once instead
// of once per fiber.
func iterRefsResolved(felts []*Felt, resolver *scopedIDResolver, yield func(resolvedRef) error) error {
	for _, f := range felts {
		for _, ref := range ExtractBodyRefs(f.Body) {
			resolved, err := resolver.Resolve(f.ID, ref.Target)
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
			resolved, err := resolver.Resolve(f.ID, targetFiber)
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
	sortCitations(citations)
	return citations
}

func sortCitations(citations []Citation) {
	sort.Slice(citations, func(i, j int) bool {
		if citations[i].SourceID != citations[j].SourceID {
			return citations[i].SourceID < citations[j].SourceID
		}
		return citations[i].Fragment < citations[j].Fragment
	})
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
	sortConsumers(consumers)
	return consumers
}

func sortConsumers(consumers []DataFlowConsumer) {
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
}

func sortedFeltIDs(felts []*Felt) []string {
	ids := make([]string, 0, len(felts))
	for _, f := range felts {
		ids = append(ids, f.ID)
	}
	sort.Strings(ids)
	return ids
}
