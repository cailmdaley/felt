package shuttlecli

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

func standingBlockFixture(dir string, runtime map[string]any) map[string]any {
	block := map[string]any{
		"kind": "standing", "host": "test-host", "agent": "claude-opus", "project_dir": dir,
		"schedule": map[string]any{"expr": "0 9 * * *", "tz": "UTC"},
	}
	if runtime != nil {
		block["runtime"] = runtime
	}
	return block
}

func handedOffAt(t *testing.T, f *felt.Felt) time.Time {
	t.Helper()
	return shuttle.RuntimeTimestamp(shuttleRuntimeMap(t, f)["handed_off_at"])
}

// A standing constitution has no review: only retirement closes it.
func TestStandingCloseRetiresOrRefuses(t *testing.T) {
	t.Parallel()
	for _, args := range [][]string{{"close", "f", "--local"}, {"close", "f", "--tempered=true", "--local"}} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			ownHost(t, env, "test-host")
			dir, storage := newStore(t)
			seedShuttleRole(t, storage, "f", felt.StatusActive, standingBlockFixture(dir, nil), nil)
			_, err := runIn(t, env, dir, args...)
			if err == nil || !strings.Contains(err.Error(), "no review") {
				t.Fatalf("close must refuse a standing review: %v", err)
			}
			if got := mustRead(t, storage, "f"); got.Status != felt.StatusActive || readTempered(got) != nil {
				t.Fatalf("refused close changed the fiber: %s %v", got.Status, readTempered(got))
			}
		})
	}
	t.Run("retire", func(t *testing.T) {
		t.Parallel()
		env := testEnv(t)
		ownHost(t, env, "test-host")
		dir, storage := newStore(t)
		seedShuttleRole(t, storage, "f", felt.StatusActive, standingBlockFixture(dir, nil), nil)
		if out, err := runIn(t, env, dir, "close", "f", "--tempered=false", "--local"); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
		got := mustRead(t, storage, "f")
		if verdict := readTempered(got); got.Status != felt.StatusClosed || verdict == nil || *verdict || got.ClosedAt == nil {
			t.Fatalf("retire must close with tempered: false: %s %v", got.Status, verdict)
		}
	})
}

// Arming a standing constitution, from a pause or a retirement, concludes its
// run so it next fires at the schedule's next tick rather than catching up.
func TestStandingArmConcludesRun(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		verb, status string
		tempered     *bool
	}{
		{"resume", felt.StatusOpen, nil},
		{"reopen", felt.StatusClosed, boolPtr(false)},
	} {
		t.Run(tc.verb, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			ownHost(t, env, "test-host")
			dir, storage := newStore(t)
			seedShuttleRole(t, storage, "f", tc.status, standingBlockFixture(dir, map[string]any{"dispatched_at": "2026-01-02T09:00:00Z"}), tc.tempered)
			before := time.Now().Add(-time.Second)
			if out, err := runIn(t, env, dir, tc.verb, "f", "--local"); err != nil {
				t.Fatalf("%v: %s", err, out)
			}
			got := mustRead(t, storage, "f")
			if got.Status != felt.StatusActive || readTempered(got) != nil || !handedOffAt(t, got).After(before) {
				t.Fatalf("arm must leave it active with its run concluded now: %s handed_off_at=%v", got.Status, shuttleRuntimeMap(t, got)["handed_off_at"])
			}
		})
	}
}

func seedConclude(t *testing.T, status string, runtime map[string]any) (*felt.Storage, standingTransitionRequest) {
	t.Helper()
	dir, st := newStore(t)
	seedShuttleRole(t, st, "role", status, standingBlockFixture(dir, runtime), nil)
	f := mustRead(t, st, "role")
	dispatched, _ := runtime["dispatched_at"].(string)
	runID, _ := runtime["run_id"].(string)
	return st, standingTransitionRequest{Path: st.Path("role"), UID: f.UID, Host: "test-host", DispatchedAt: dispatched, RunID: runID}
}

func TestConcludeStandingRun(t *testing.T) {
	t.Parallel()
	run := func() map[string]any {
		return map[string]any{"dispatched_at": "2026-01-02T09:00:00Z", "run_id": "20260102T090000+0000"}
	}
	t.Run("an exit without handoff stays armed, concluded now", func(t *testing.T) {
		t.Parallel()
		st, req := seedConclude(t, felt.StatusActive, run())
		before := time.Now().Add(-time.Second)
		result, err := concludeStandingRun(req)
		if err != nil || !result.Changed {
			t.Fatalf("conclude: %+v %v", result, err)
		}
		got := mustRead(t, st, "role")
		if got.Status != felt.StatusActive || !handedOffAt(t, got).After(before) {
			t.Fatalf("exit must re-arm with handed_off_at now: %s %v", got.Status, shuttleRuntimeMap(t, got))
		}
	})
	t.Run("a recovered exit concludes at its dispatch, keeping a missed occurrence due", func(t *testing.T) {
		t.Parallel()
		st, req := seedConclude(t, felt.StatusActive, run())
		req.Recovery = true
		if _, err := concludeStandingRun(req); err != nil {
			t.Fatal(err)
		}
		want := time.Date(2026, 1, 2, 9, 0, 0, 0, time.UTC)
		if got := handedOffAt(t, mustRead(t, st, "role")); !got.Equal(want) {
			t.Fatalf("recovery stamp %v, want %v", got, want)
		}
	})
	for name, tc := range map[string]struct {
		status  string
		runtime map[string]any
		mutate  func(*standingTransitionRequest)
	}{
		"a handed-off run":    {felt.StatusActive, map[string]any{"dispatched_at": "2026-01-02T09:00:00Z", "run_id": "r", "handed_off_at": "2026-01-02T09:30:00Z"}, nil},
		"a paused schedule":   {felt.StatusOpen, run(), nil},
		"a newer run":         {felt.StatusActive, run(), func(r *standingTransitionRequest) { r.DispatchedAt = "2026-01-01T09:00:00Z" }},
		"another host's role": {felt.StatusActive, run(), func(r *standingTransitionRequest) { r.Host = "elsewhere" }},
	} {
		t.Run("leaves "+name, func(t *testing.T) {
			t.Parallel()
			st, req := seedConclude(t, tc.status, tc.runtime)
			if tc.mutate != nil {
				tc.mutate(&req)
			}
			before := mustRead(t, st, "role")
			result, err := concludeStandingRun(req)
			if err != nil || result.Changed {
				t.Fatalf("conclude must skip: %+v %v", result, err)
			}
			after := mustRead(t, st, "role")
			if after.Status != before.Status || shuttleRuntimeMap(t, after)["handed_off_at"] != shuttleRuntimeMap(t, before)["handed_off_at"] {
				t.Fatalf("skipped conclude wrote: %v", shuttleRuntimeMap(t, after))
			}
		})
	}
}

func TestConcludeRunCommand(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	st, req := seedConclude(t, felt.StatusActive, map[string]any{"dispatched_at": "2026-01-02T09:00:00Z", "run_id": "r"})
	body, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	out, err := runIn(t, env, st.Root(), "conclude-run", "--request-json", string(body))
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	var result standingTransitionResult
	if err := json.Unmarshal([]byte(out), &result); err != nil || !result.Changed {
		t.Fatalf("reply %q: %v", out, err)
	}
}

func boolPtr(v bool) *bool { return &v }
