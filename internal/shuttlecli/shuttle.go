package shuttlecli

import (
	"fmt"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

// resolveShuttleJSON decorates mapping-valued Shuttle facets for a Shuttle JSON
// view. It loads the agent registry only when the result contains a facet.
func resolveShuttleJSON(felts ...*felt.Felt) error {
	hasFacet := false
	for _, f := range felts {
		if shuttle.HasFacet(f) {
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
		if err := shuttle.Resolve(f, reg, now); err != nil {
			return err
		}
	}
	return nil
}
