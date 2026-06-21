package cmd

import (
	"fmt"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

// attachShuttleResolution resolves the shuttle: facet on each fiber that carries
// one, for the JSON emit paths (felt show -j / ls --json). The agent registry is
// loaded once, and only when at least one fiber actually has a facet, so a query
// over pure notes pays nothing. Fibers without a facet are untouched. Per-fiber
// resolution errors (e.g. an unknown agent on a legacy block) are non-fatal —
// AttachShuttleResolution emits the flat block without a resolved sub-key — so a
// read never fails on a stale block; only a corrupt block surfaces an error.
func attachShuttleResolution(felts ...*felt.Felt) error {
	hasFacet := false
	for _, f := range felts {
		if f.HasShuttleFacet() {
			hasFacet = true
			break
		}
	}
	if !hasFacet {
		return nil
	}
	reg, err := shuttle.LoadAgentRegistry()
	if err != nil {
		return fmt.Errorf("loading agent registry: %w", err)
	}
	now := time.Now()
	for _, f := range felts {
		if err := f.AttachShuttleResolution(reg, now); err != nil {
			return err
		}
	}
	return nil
}
