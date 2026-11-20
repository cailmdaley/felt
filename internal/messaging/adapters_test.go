package messaging

import (
	"testing"

	"github.com/cailmdaley/felt/internal/harness"
)

// Every harness Shuttle runs workers on can be discovered and sent to.
func TestEveryHarnessHasADeliveryAdapter(t *testing.T) {
	t.Parallel()
	adapters := adapters()
	if len(adapters) != len(harness.All()) {
		t.Fatalf("%d adapters for %d harnesses", len(adapters), len(harness.All()))
	}
	for _, f := range harness.All() {
		if adapters[f.Name] == nil {
			t.Errorf("no messaging adapter for %s", f.Name)
		}
	}
}
