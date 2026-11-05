package shuttlecli

import (
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

func TestStandingNeverRunCloseRecordsVerdict(t *testing.T) {
	t.Parallel()
	for _, status := range []string{felt.StatusOpen, felt.StatusActive, felt.StatusClosed} {
		t.Run(status, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			ownHost(t, env, "test-host")
			dir, storage := newStore(t)
			// An ordinary verdict needs neither an armable block nor a schedule.
			seedShuttleRole(t, storage, "f", status, map[string]any{"kind": "standing", "host": "test-host"}, nil)
			out, err := runIn(t, env, dir, "close", "f", "--tempered=true", "--local")
			if err != nil {
				t.Fatalf("%v: %s", err, out)
			}
			f := mustRead(t, storage, "f")
			verdict := readTempered(f)
			if f.Status != felt.StatusClosed || verdict == nil || !*verdict || f.ClosedAt == nil {
				t.Fatalf("close must record an ordinary verdict: %#v", f)
			}
			if strings.Contains(out, "accepted run") || shuttleRuntimeMap(t, f)["handed_off_at"] != nil {
				t.Fatalf("never-run close armed a run: %s", out)
			}
		})
	}
}

func TestStandingRearmClearsRequests(t *testing.T) {
	t.Parallel()
	for _, verb := range []string{"accept", "close", "occurrence"} {
		t.Run(verb, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			ownHost(t, env, "test-host")
			dir, storage := newStore(t)
			seedShuttleRole(t, storage, "f", felt.StatusClosed, map[string]any{
				"kind": "standing", "host": "test-host", "project_dir": dir,
				"schedule":   map[string]any{"expr": "0 0 * * *", "tz": "UTC"},
				"runtime":    map[string]any{"dispatched_at": "2026-01-01T00:00:00Z"},
				"ask":        map[string]any{"text": "Old question", "at": "2026-01-01T01:00:00Z"},
				"blocked_on": "Old dependency",
			}, nil)
			f := mustRead(t, storage, "f")
			f.CreatedAt = time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
			closed := time.Date(2026, 1, 1, 1, 0, 0, 0, time.UTC)
			f.ClosedAt = &closed
			if err := storage.Write(f); err != nil {
				t.Fatal(err)
			}
			args := []string{verb, "f", "--local"}
			if verb == "close" {
				args = append(args, "--tempered=true")
			}
			if verb == "occurrence" {
				args = []string{"reopen", "f", "--occurrence", "--local"}
			}
			if out, err := runIn(t, env, dir, args...); err != nil {
				t.Fatalf("%v: %s", err, out)
			}
			got := mustRead(t, storage, "f")
			block, _, err := shuttle.BlockOf(got)
			if err != nil {
				t.Fatal(err)
			}
			if got.Status != felt.StatusActive || block.Ask != nil || block.BlockedOn != "" {
				t.Fatalf("re-arm retained a stale request: %#v", block)
			}
		})
	}
}

func TestCloseReportsUnsetTruthfully(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{"oneshot", "standing"} {
		t.Run(kind, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			ownHost(t, env, "test-host")
			dir, storage := newStore(t)
			seedShuttleRole(t, storage, "f", felt.StatusActive, map[string]any{"kind": kind, "host": "test-host"}, nil)
			out, err := runIn(t, env, dir, "close", "f", "--local")
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(out, "tempered: cleared") || !strings.Contains(out, "tempered: unset") {
				t.Fatalf("untrue verdict message: %s", out)
			}
		})
	}
}
