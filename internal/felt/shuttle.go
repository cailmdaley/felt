package felt

import (
	"fmt"

	"github.com/cailmdaley/felt/internal/shuttle"
)

// shuttleFacetKey is the top-level frontmatter key felt interprets as the
// optional shuttle dispatch facet. Unlike every other ExtraFields namespace
// (which felt round-trips opaquely), felt owns this one's schema: it validates
// it on write and resolves it on read. The block stays in ExtraFields as the
// canonical bytes — the typed view below is derived, never the storage form.
const shuttleFacetKey = "shuttle"

// HasShuttleFacet reports whether the fiber carries a shuttle: block. A fiber
// without one is a pure note: felt validates nothing extra and the note-taking
// experience is byte-for-byte unchanged (the optional-facet invariant).
func (f *Felt) HasShuttleFacet() bool {
	node, ok := f.ExtraFields[shuttleFacetKey]
	return ok && node != nil
}

// ShuttleBlock decodes the fiber's shuttle: facet into a typed Block. Returns
// (nil, false, nil) when the fiber carries no shuttle: block. The runtime /
// continuation fields (session_uuid, dispatched_at, handed_off_at, run_id) are
// deliberately not modeled by Block — they remain in the ExtraFields node and
// ride through untouched; yaml decoding ignores keys the struct does not name,
// so a block carrying them decodes cleanly.
func (f *Felt) ShuttleBlock() (*shuttle.Block, bool, error) {
	node, ok := f.ExtraFields[shuttleFacetKey]
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
