package shuttlecli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

func seedStandingTransition(t *testing.T) (*felt.Storage, standingTransitionRequest) {
	t.Helper()
	_, st := newStore(t)
	seedShuttleRole(t, st, "role", felt.StatusActive, map[string]any{"kind": "standing", "host": "test-host", "runtime": map[string]any{"dispatched_at": "2026-01-02T00:00:00Z", "run_id": "scheduled-2"}}, nil)
	f := mustRead(t, st, "role")
	return st, standingTransitionRequest{Path: st.Path("role"), UID: f.UID, Host: "test-host", DispatchedAt: "2026-01-02T00:00:00Z", RunID: "scheduled-2", Action: "awaiting", Recovery: true}
}

func TestPausedHandoffThenHumanArmSurvivesRecovery(t *testing.T) {
	for _, verb := range []string{"resume", "reopen"} {
		t.Run(verb, func(t *testing.T) {
			st, req := seedStandingTransition(t)
			env := testEnv(t)
			env.Set("SHUTTLE_HOST", "test-host")
			if _, err := st.Update("role", func(f *felt.Felt) error { return shuttle.SetField(f, "project_dir", filepath.Dir(st.Root())) }); err != nil {
				t.Fatal(err)
			}
			for _, args := range [][]string{{"pause", "role", "--no-kill", "--local"}, {"handoff", "role"}, {verb, "role", "--local"}} {
				if out, err := runIn(t, env, filepath.Dir(st.Root()), args...); err != nil {
					t.Fatalf("%v: %v %s", args, err, out)
				}
			}
			result, err := applyStandingTransition(req)
			if err != nil || result.Changed || mustRead(t, st, "role").Status != felt.StatusActive {
				t.Fatalf("human arm undone: %+v %v", result, err)
			}
		})
	}
}

func TestStandingExitLockedReloadPreservesConcurrentEdits(t *testing.T) {
	t.Parallel()
	st, req := seedStandingTransition(t)
	unlock, err := st.LockFiber("role")
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	done := make(chan error, 1)
	go func() { _, err := applyStandingTransition(req); done <- err }()
	select {
	case err := <-done:
		t.Fatalf("exit bypassed held document lock: %v", err)
	case <-time.After(200 * time.Millisecond):
	}
	f := mustRead(t, st, "role")
	f.Outcome = "Latest worker digest"
	f.Body = "Latest body"
	if err := f.SetExtraField("custom", "keep"); err != nil {
		t.Fatal(err)
	}
	if err := st.Write(f); err != nil {
		t.Fatal(err)
	}
	if err := unlock(); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	f = mustRead(t, st, "role")
	if f.Status != felt.StatusClosed || f.Body != "Latest body" || f.Outcome != "Latest worker digest" || f.ExtraFields["custom"].Value != "keep" {
		t.Fatalf("exit lost locked update: %+v", f)
	}
}

func TestStandingExitRejectsStaleRunAndHumanTransitions(t *testing.T) {
	t.Parallel()
	for _, change := range []string{"accept", "rest", "pause", "new-dispatch", "new-owner", "tempered"} {
		t.Run(change, func(t *testing.T) {
			st, req := seedStandingTransition(t)
			_, err := st.Update("role", func(f *felt.Felt) error {
				switch change {
				case "accept":
					return rearmStanding(f, time.Now().UTC().Format(time.RFC3339Nano))
				case "rest":
					return f.SetStatus(felt.StatusOpen, time.Now())
				case "pause":
					return unclose(f, felt.StatusOpen)
				case "new-dispatch":
					return shuttle.SetRuntimeField(f, "dispatched_at", "2026-01-03T00:00:00Z")
				case "new-owner":
					node := felt.MappingValueNode(f.ExtraFields["shuttle"], "host")
					node.Value = "another-host"
				case "tempered":
					return f.SetExtraField("tempered", true)
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			before, _ := os.ReadFile(req.Path)
			result, err := applyStandingTransition(req)
			if err != nil {
				t.Fatal(err)
			}
			after, _ := os.ReadFile(req.Path)
			if result.Changed || string(after) != string(before) {
				t.Fatalf("stale exit overwrote %s: %s", change, after)
			}
		})
	}
}

func TestStandingRunDispositionAndRecoveryPolicy(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, handoff, verb, run string
		recovery, want           bool
	}{
		{"first dirty", "", "", "scheduled-2", true, true},
		{"second dirty", "2026-01-01T00:00:00Z", "rearmed", "scheduled-2", true, true},
		{"worker handoff during downtime", "2026-01-03T00:00:00Z", "handed off", "scheduled-2", true, true},
		{"human rearm", "2026-01-03T00:00:00Z", "rearmed", "scheduled-2", true, false},
		{"accepted close", "2026-01-03T00:00:00Z", "tempered", "scheduled-2", false, false},
		{"occurrence rearm", "2026-01-02T00:00:00Z", "rearmed", "scheduled-2", true, false},
		{"late exit after occurrence rearm", "2026-01-02T00:00:00Z", "rearmed", "scheduled-2", false, false},
		{"new dirty run after accepted close", "2026-01-01T00:00:00Z", "tempered", "scheduled-2", true, true},
		{"dirty ad hoc recovery", "", "", "adhoc-123", true, false},
		{"clean ad hoc recovery", "2026-01-03T00:00:00Z", "handed off", "adhoc-123", true, false},
		{"observed ad hoc exit", "", "", "adhoc-123", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st, req := seedStandingTransition(t)
			req.RunID = tc.run
			req.Recovery = tc.recovery
			_, err := st.Update("role", func(f *felt.Felt) error {
				for k, v := range map[string]string{"handed_off_at": tc.handoff, "thread_exit_verb": tc.verb, "run_id": tc.run} {
					if err := shuttle.SetRuntimeField(f, k, v); err != nil {
						return err
					}
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			result, err := applyStandingTransition(req)
			if err != nil || result.Changed != tc.want {
				t.Fatalf("transition = %+v, %v, want changed %t", result, err, tc.want)
			}
		})
	}
}

func TestUnrecordedLaunchRequiresAnObservedExit(t *testing.T) {
	t.Parallel()
	for _, recovery := range []bool{true, false} {
		st, req := seedStandingTransition(t)
		req.DispatchedAt = ""
		req.Recovery = recovery
		_, err := st.Update("role", func(f *felt.Felt) error {
			return shuttle.SetRuntimeField(f, "dispatched_at", "")
		})
		if err != nil {
			t.Fatal(err)
		}
		result, err := applyStandingTransition(req)
		if err != nil || result.Changed == recovery {
			t.Fatalf("unrecorded launch (recovery=%t): %+v, %v", recovery, result, err)
		}
	}
}

func TestWorkerHandoffCannotEraseCurrentHumanRearm(t *testing.T) {
	t.Parallel()
	st, req := seedStandingTransition(t)
	if _, err := st.Update("role", func(f *felt.Felt) error {
		return rearmStanding(f, time.Now().UTC().Format(time.RFC3339Nano))
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := stampHandedOff(req.Path, nil); err != nil {
		t.Fatal(err)
	}
	result, err := applyStandingTransition(req)
	if err != nil || result.Changed || runtimeString(mustRead(t, st, "role"), "thread_exit_verb") != "rearmed" {
		t.Fatalf("worker handoff erased human acceptance: %+v, %v", result, err)
	}
}

func TestStandingOwnerRearmSurvivesLateHandoffAndExit(t *testing.T) {
	t.Parallel()
	for _, verb := range []string{"occurrence", "accepted-close"} {
		t.Run(verb, func(t *testing.T) {
			t.Parallel()
			st, req := seedStandingTransition(t)
			env := testEnv(t)
			ownHost(t, env, req.Host)
			_, err := st.Update("role", func(f *felt.Felt) error {
				f.CreatedAt = time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
				if err := f.SetStatus(felt.StatusClosed, time.Date(2026, 1, 2, 0, 1, 0, 0, time.UTC)); err != nil {
					return err
				}
				if err := shuttle.SetNodeField(f, "schedule", map[string]any{"expr": "0 0 * * *", "tz": "UTC"}); err != nil {
					return err
				}
				return shuttle.SetField(f, "project_dir", filepath.Dir(st.Root()))
			})
			if err != nil {
				t.Fatal(err)
			}
			args := []string{"reopen", "role", "--occurrence", "--local"}
			if verb == "accepted-close" {
				args = []string{"close", "role", "--tempered=true", "--local"}
			}
			if out, err := runIn(t, env, filepath.Dir(st.Root()), args...); err != nil {
				t.Fatalf("rearm: %v: %s", err, out)
			}
			before, _ := os.ReadFile(req.Path)
			for _, recovery := range []bool{false, true} {
				req.Recovery = recovery
				if _, err := stampHandedOff(req.Path, nil); err != nil {
					t.Fatal(err)
				}
				result, err := applyStandingTransition(req)
				after, _ := os.ReadFile(req.Path)
				if err != nil || result.Changed || string(after) != string(before) {
					t.Fatalf("late exit (recovery=%t) undid %s: %+v %v", recovery, verb, result, err)
				}
			}
			if verb == "occurrence" && runtimeString(mustRead(t, st, "role"), "handed_off_at") != req.DispatchedAt {
				t.Fatal("occurrence rearm consumed its due occurrence")
			}
		})
	}
}

func TestStandingTransitionCommandAndAtomicForceRearm(t *testing.T) {
	t.Parallel()
	st, req := seedStandingTransition(t)
	_, err := st.Update("role", func(f *felt.Felt) error {
		if err := f.SetStatus(felt.StatusClosed, time.Now()); err != nil {
			return err
		}
		if err := f.SetExtraField("ask", map[string]any{"text": "Keep this question"}); err != nil {
			return err
		}
		return shuttle.SetField(f, "blocked_on", "A question for the human")
	})
	if err != nil {
		t.Fatal(err)
	}
	req.Action = "rearm"
	raw, _ := json.Marshal(req)
	out, err := runIn(t, testEnv(t), st.Root(), "standing-transition", "--request-json", string(raw))
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	f := mustRead(t, st, "role")
	if f.Status != felt.StatusActive || runtimeString(f, "handed_off_at") == "" || runtimeString(f, "thread_exit_verb") != "rearmed" || f.ExtraFields["ask"] == nil {
		t.Fatalf("partial force rearm: %+v", f)
	}
	blockedOn := felt.MappingValueNode(f.ExtraFields["shuttle"], "blocked_on")
	if blockedOn == nil || blockedOn.Value != "A question for the human" {
		t.Fatal("force rearm cleared blocked_on")
	}
	if !strings.Contains(out, `"changed":true`) {
		t.Fatal(out)
	}
}
