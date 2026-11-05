package shuttlecli

import (
	"fmt"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestHandoffKeepsRearmOnlyForItsOwnRun(t *testing.T) {
	t.Parallel()
	for _, verb := range []string{"tempered", "rearmed"} {
		for _, nextRun := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/next-run-%v", verb, nextRun), func(t *testing.T) {
				t.Parallel()
				_, storage := newStore(t)
				now := time.Now().UTC()
				dispatch := now.Add(-30 * time.Minute)
				handoff := now.Add(-20 * time.Minute)
				if nextRun {
					dispatch = now.Add(-10 * time.Minute)
				}
				seedShuttleRole(t, storage, "f", felt.StatusActive, map[string]any{"kind": "standing", "runtime": map[string]any{"dispatched_at": dispatch.Format(time.RFC3339Nano), "handed_off_at": handoff.Format(time.RFC3339Nano), "thread_exit_verb": verb}}, nil)
				if _, err := stampHandedOff(storage.Path("f"), nil); err != nil {
					t.Fatal(err)
				}
				want := verb
				if nextRun {
					want = "handed off"
				}
				if got := shuttleRuntimeMap(t, mustRead(t, storage, "f"))["thread_exit_verb"]; got != want {
					t.Fatalf("got %v, want %v", got, want)
				}
			})
		}
	}
}
