package felt

import (
	"fmt"
	"time"

	"github.com/cailmdaley/felt/internal/shuttle"
)

// ShuttleFacetKey is the top-level frontmatter key felt interprets as the
// optional shuttle dispatch facet. Unlike every other ExtraFields namespace
// (which felt round-trips opaquely), felt owns this one's schema: it validates
// it on write and resolves it on read. The block stays in ExtraFields as the
// canonical bytes — the typed/resolved views below are derived, never the
// storage form.
const ShuttleFacetKey = "shuttle"

// HasShuttleFacet reports whether the fiber carries a shuttle: block. A fiber
// without one is a pure note: felt validates nothing extra and the note-taking
// experience is byte-for-byte unchanged (the optional-facet invariant).
func (f *Felt) HasShuttleFacet() bool {
	node, ok := f.ExtraFields[ShuttleFacetKey]
	return ok && node != nil
}

// ShuttleBlock decodes the fiber's shuttle: facet into a typed Block. Returns
// (nil, false, nil) when the fiber carries no shuttle: block. The runtime /
// continuation fields (session_uuid, dispatched_at, handed_off_at, run_id) are
// deliberately not modeled by Block — they remain in the ExtraFields node and
// ride through untouched; yaml decoding ignores keys the struct does not name,
// so a block carrying them decodes cleanly.
func (f *Felt) ShuttleBlock() (*shuttle.Block, bool, error) {
	node, ok := f.ExtraFields[ShuttleFacetKey]
	if !ok || node == nil {
		return nil, false, nil
	}
	var b shuttle.Block
	if err := node.Decode(&b); err != nil {
		return nil, true, fmt.Errorf("shuttle: block is malformed: %w", err)
	}
	return &b, true, nil
}

// ValidateShuttleFacet validates the fiber's shuttle: facet (kind enum, agent
// resolution against the registry, pinned-forbids-schedule, standing-requires a
// valid cron + timezone). It is a no-op for a pure note — and only loads the
// agent registry when a facet is actually present, so notes pay nothing. felt's
// write verbs call this before persisting, making felt the schema authority: an
// invalid shuttle: block fails the write loudly rather than reaching disk.
func (f *Felt) ValidateShuttleFacet() error {
	b, ok, err := f.ShuttleBlock()
	if err != nil {
		return err
	}
	if !ok {
		return nil
	}
	reg, err := shuttle.LoadAgentRegistry()
	if err != nil {
		return fmt.Errorf("loading agent registry: %w", err)
	}
	if errs := shuttle.Validate(b, reg); len(errs) > 0 {
		return fmt.Errorf("invalid shuttle: block:\n%s", errs.Error())
	}
	return nil
}

// AttachShuttleResolution computes the resolved view of the fiber's shuttle:
// facet and stashes it for the JSON emit paths (MarshalJSON, feltJSONField). It
// is additive and read-only: the resolved object carries the flat block exactly
// as felt emits it today PLUS a `resolved` sub-key (agent base record + effective
// axes, and next_due for standing roles), so the daemon's contract on the flat
// fields is untouched. A no-op for a pure note. A resolution error (e.g. an
// unknown agent on a legacy block) is non-fatal: the flat block still emits, just
// without the resolved sub-key — a read must never fail on a stale block.
//
// The resolved view lives in a dedicated field, never in ExtraFields, so it is
// emitted on read but can never be persisted back to disk by a later write.
func (f *Felt) AttachShuttleResolution(reg *shuttle.AgentRegistry, now time.Time) error {
	node, ok := f.ExtraFields[ShuttleFacetKey]
	if !ok || node == nil {
		return nil
	}
	// Decode the flat block faithfully — the same shape felt emits today.
	var flat map[string]interface{}
	if err := node.Decode(&flat); err != nil {
		return fmt.Errorf("decode shuttle: block: %w", err)
	}
	// Resolve the typed config; on any error leave the flat block un-augmented.
	var b shuttle.Block
	if err := node.Decode(&b); err == nil {
		if res, err := shuttle.ResolveBlock(&b, reg, now); err == nil && !res.IsEmpty() {
			flat["resolved"] = res
		}
	}
	f.resolvedShuttle = flat
	return nil
}

// ResolvedShuttle returns the resolved shuttle facet attached by
// AttachShuttleResolution, if any. The JSON emit paths use it in place of the
// raw ExtraFields decode so the `resolved` sub-key rides along.
func (f *Felt) ResolvedShuttle() (map[string]interface{}, bool) {
	return f.resolvedShuttle, f.resolvedShuttle != nil
}
