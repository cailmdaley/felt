package felt

import (
	"fmt"
	"time"

	"github.com/cailmdaley/felt/internal/shuttle"
	"gopkg.in/yaml.v3"
)

// ShuttleFacetKey is the top-level frontmatter key felt interprets as the
// optional shuttle dispatch facet. Unlike every other ExtraFields namespace
// (which felt round-trips opaquely), felt owns this one's schema: it validates
// it on write and resolves it on read. The block stays in ExtraFields as the
// canonical bytes — the typed/resolved views below are derived, never the
// storage form.
const ShuttleFacetKey = "shuttle"

// shuttleMappingNode returns the shuttle: facet node iff its value is a YAML
// mapping — the only shape felt interprets as a dispatch facet, matching the
// daemon's own is_map(shuttle) predicate. A shuttle: key whose value is null, a
// scalar, or a sequence is degenerate, not a facet: felt round-trips it opaquely
// like any other ExtraField and neither validates nor resolves it. This keeps a
// malformed block from ever failing a read (felt show -j / ls --json) or
// blocking an unrelated write.
func (f *Felt) shuttleMappingNode() (*yaml.Node, bool) {
	node, ok := f.ExtraFields[ShuttleFacetKey]
	if !ok || node == nil || node.Kind != yaml.MappingNode {
		return nil, false
	}
	return node, true
}

// HasShuttleFacet reports whether the fiber carries a well-formed shuttle: block
// (a YAML mapping). A fiber without one is a pure note: felt validates nothing
// extra and the note-taking experience is byte-for-byte unchanged (the
// optional-facet invariant).
func (f *Felt) HasShuttleFacet() bool {
	_, ok := f.shuttleMappingNode()
	return ok
}

// ShuttleBlock decodes the fiber's shuttle: facet into a typed Block. Returns
// (nil, false, nil) when the fiber carries no well-formed shuttle: block. The
// runtime / continuation fields (session_uuid, dispatched_at, handed_off_at,
// run_id) are deliberately not modeled by Block — they remain in the node and
// ride through untouched; yaml decoding ignores keys the struct does not name,
// so a block carrying them decodes cleanly.
func (f *Felt) ShuttleBlock() (*shuttle.Block, bool, error) {
	node, ok := f.shuttleMappingNode()
	if !ok {
		return nil, false, nil
	}
	var b shuttle.Block
	if err := node.Decode(&b); err != nil {
		return nil, true, fmt.Errorf("shuttle: block is malformed: %w", err)
	}
	return &b, true, nil
}

// SetShuttleField surgically sets a single key inside the fiber's existing
// shuttle: mapping, mutating the node in place so every sibling — crucially the
// daemon-owned runtime/continuation keys (session_uuid, dispatched_at,
// handed_off_at, run_id) that the typed Block deliberately does not model —
// rides through untouched. It is the write-side counterpart to ShuttleBlock:
// where decoding to the typed Block and re-encoding (or a whole-block
// SetExtraField replace) would DROP any key the struct omits, this preserves
// them, so a config edit can never clobber runtime state. felt's Write
// re-marshals the ExtraFields nodes, so the in-place mutation persists with no
// SetExtraField round-trip.
//
// Returns an error if the fiber carries no well-formed shuttle: block — the
// caller is expected to operate on an installed role (a worker stamping
// handed_off_at, set-model changing the agent, …). To CREATE a block, build a
// shuttle.Block and SetExtraField("shuttle", block); there are no runtime keys
// to preserve at creation.
func (f *Felt) SetShuttleField(key, value string) error {
	node, ok := f.shuttleMappingNode()
	if !ok {
		return fmt.Errorf("shuttle: no shuttle block present to set %q on", key)
	}
	setMappingScalar(node, key, value)
	return nil
}

// ValidateShuttleFacet validates the fiber's shuttle: facet (kind enum, agent
// resolution against the registry, pinned-forbids-schedule, standing-requires a
// valid cron + timezone). It is a no-op for a pure note (or a degenerate
// non-mapping shuttle value) — and only loads the agent registry when a facet is
// actually present, so notes pay nothing. felt's write verbs call this before
// persisting, making felt the schema authority: an invalid shuttle: block fails
// the write loudly rather than reaching disk.
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
// fields is untouched. A no-op for a pure note or a degenerate non-mapping block.
//
// A read must never fail on a stale or malformed block: a block that does not
// decode into the typed config still emits its flat form (just without the
// resolved sub-key), and any other anomaly leaves the raw passthrough in place.
// The resolved view lives in a dedicated field, never in ExtraFields, so it is
// emitted on read but can never be persisted back to disk by a later write.
func (f *Felt) AttachShuttleResolution(reg *shuttle.AgentRegistry, now time.Time) error {
	node, ok := f.shuttleMappingNode()
	if !ok {
		return nil
	}
	// The flat block: a faithful YAML round-trip of the raw bytes (not a pass
	// through the typed struct), so no field can be dropped or reshaped. A
	// mapping node always decodes to a non-nil map; guard anyway and fall back
	// to the opaque passthrough rather than ever failing the read.
	var flat map[string]interface{}
	if err := node.Decode(&flat); err != nil || flat == nil {
		return nil
	}
	// Resolve the typed config; on any error leave the flat block un-augmented.
	var b shuttle.Block
	if err := node.Decode(&b); err == nil {
		if res, err := shuttle.ResolveBlock(&b, reg, now); err == nil && !res.IsEmpty() {
			// Never clobber a real `resolved` key the block already declared
			// (none does today — felt owns the facet — but stay symmetric with
			// MarshalJSON's known-keys-win merge).
			if _, exists := flat["resolved"]; !exists {
				flat["resolved"] = res
			}
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
