package shuttlecli

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/messaging"
)

// The old source still exists: identity must follow assignment, not a rename
// of the source document or a missing-path recovery heuristic.
func TestWorkerExitInfersMigratedPane(t *testing.T) {
	t.Parallel()
	for _, verb := range []string{"handoff", "close", "rest"} {
		for _, explicitSource := range []bool{false, true} {
			name := verb + "/implicit"
			if explicitSource {
				name = verb + "/explicit-source"
			}
			t.Run(name, func(t *testing.T) {
				t.Parallel()
				env := testEnv(t)
				dir, st := newStore(t)
				seedShuttleRole(t, st, "source", felt.StatusActive, oneshot(), nil)
				seedShuttleRole(t, st, "destination", felt.StatusActive, oneshot(), nil)
				dest := mustRead(t, st, "destination")
				env.Set("SHUTTLE_FIBER_PATH", st.Path("source"))
				kills, _ := stubWorkerExitTmux(t, env, shuttleTmuxSessionName(dest.ID, dest.UID), dest.Path)
				args := []string{verb}
				if explicitSource {
					args = append(args, "source")
				}
				if verb == "rest" {
					args = append(args, "--local")
				}
				if out, err := runIn(t, env, dir, args...); err != nil {
					t.Fatalf("%v: %v\n%s", args, err, out)
				}
				target, untouched := "destination", "source"
				if explicitSource {
					target, untouched = untouched, target
				}
				f := mustRead(t, st, target)
				switch verb {
				case "close":
					if f.Status != felt.StatusClosed {
						t.Fatalf("target not closed: %s", f.Status)
					}
				case "rest":
					if f.Status != felt.StatusOpen || !horizonStashed(f) {
						t.Fatal("target not resting")
					}
				case "handoff":
					if !workerHasHandoff(f) {
						t.Fatal("target not handed off")
					}
				}
				if f := mustRead(t, st, untouched); f.Status != felt.StatusActive || workerHasHandoff(f) {
					t.Fatal("wrong fiber mutated")
				}
				if explicitSource {
					if _, err := os.Stat(kills); !os.IsNotExist(err) {
						t.Fatal("explicit other fiber killed caller")
					}
				} else if verb != "rest" {
					if _, err := os.Stat(kills); err != nil {
						t.Fatalf("self exit did not kill renamed session: %v", err)
					}
				}
			})
		}
	}
}

func TestNativeWorkerIdentityFollowsLedgerAcrossStores(t *testing.T) {
	t.Parallel()
	for _, verb := range []string{"handoff", "close", "rest"} {
		t.Run(verb, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			sourceDir, source := newStore(t)
			_, destStore := newStore(t)
			seedShuttleRole(t, source, "source", felt.StatusActive, oneshot(), nil)
			seedShuttleRole(t, destStore, "nested/destination", felt.StatusActive, oneshot(), nil)
			src, dst := mustRead(t, source, "source"), mustRead(t, destStore, "nested/destination")
			env.Set("CODEX_THREAD_ID", "native-thread")
			env.Set("SHUTTLE_FIBER_PATH", src.Path)
			env.Set("SHUTTLE_HOST", "test-host")
			// Shared App Server environment contains the source terminal, not this
			// native thread's viewer. Never terminate that unrelated terminal.
			kills, _ := stubWorkerExitTmux(t, env, shuttleTmuxSessionName(src.ID, src.UID), src.Path)
			records := []SessionProvenance{
				{Kind: "dispatch", Host: "test-host", Harness: "codex", Session: "native-thread", Fiber: src.ID, UID: src.UID, At: 1},
				{Kind: "migrate", Host: "test-host", Harness: "codex", Session: "native-thread", Fiber: dst.ID, UID: dst.UID, FiberPath: dst.Path, At: 2},
			}
			writeMessageIdentityLedger(t, env, records)
			env.Chdir(sourceDir)
			a := newApp(env)
			f, err := a.currentWorkerFiber()
			if err != nil || f == nil || f.UID != dst.UID || !a.samePath(f.Path, dst.Path) {
				t.Fatalf("inference = %+v (%v)", f, err)
			}
			if got := a.messageReplyTarget("shuttle://test-host/codex/native-thread"); got != dst.ID {
				t.Fatalf("reply_to = %q", got)
			}
			if worker, err := newestFiberWorkerRecord(src, records); err != nil || worker != nil {
				t.Fatalf("source retained moved worker: %+v (%v)", worker, err)
			}
			if worker, err := newestFiberWorkerRecord(dst, records); err != nil || worker == nil || worker.Kind != "migrate" {
				t.Fatalf("destination worker = %+v (%v)", worker, err)
			}
			args := []string{verb}
			if verb == "rest" {
				args = append(args, "--local")
			}
			if out, err := runIn(t, env, sourceDir, args...); err != nil {
				t.Fatalf("%s: %v\n%s", verb, err, out)
			}
			if _, err := os.Stat(kills); !os.IsNotExist(err) {
				t.Fatal("native app exit killed inherited source terminal")
			}
			if f := mustRead(t, source, "source"); f.Status != felt.StatusActive || workerHasHandoff(f) {
				t.Fatal("source mutated")
			}
			dest := mustRead(t, destStore, dst.ID)
			if verb == "close" && dest.Status != felt.StatusClosed || verb == "rest" && !horizonStashed(dest) || verb == "handoff" && !workerHasHandoff(dest) {
				t.Fatal("destination not updated")
			}
		})
	}
}

func TestNativeWorkerDoesNotInheritUnboundIdentity(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, st := newStore(t)
	seedShuttleRole(t, st, "parent", felt.StatusActive, oneshot(), nil)
	parent := mustRead(t, st, "parent")
	env.Chdir(dir)
	env.Set("SHUTTLE_FIBER_PATH", parent.Path)
	env.Set("AI_AGENT", "pi")
	env.Set("PI_SESSION_ID", "unbound-child")
	env.Set("CODEX_THREAD_ID", "inherited-codex")
	env.Set("SHUTTLE_HOST", "test-host")
	kills, _ := stubWorkerExitTmux(t, env, shuttleTmuxSessionName(parent.ID, parent.UID), parent.Path)
	a := newApp(env)
	if _, err := a.currentWorkerFiber(); err == nil {
		t.Fatal("unbound nested harness inherited worker assignment")
	}
	if a.isOwnFiber(parent) {
		t.Fatal("parent falsely recognized as own fiber")
	}
	a.endOwnTmuxSession()
	if _, err := os.Stat(kills); !os.IsNotExist(err) {
		t.Fatal("unbound child killed parent's terminal")
	}
}

func TestSessionBindingNewestAndConflicting(t *testing.T) {
	t.Parallel()
	address := messaging.Address{Host: "test-host", Harness: "codex", ID: "thread"}
	old := SessionProvenance{Host: address.Host, Harness: address.Harness, Session: address.ID, Fiber: "old", UID: "old-uid", Kind: "claim", At: 10}
	moved := old
	moved.Fiber, moved.UID, moved.Kind, moved.At = "new", "new-uid", "migrate", 20
	f := messageSessionFiber(address, []SessionProvenance{moved, old})
	if f == nil || f.ID != "new" {
		t.Fatalf("newest binding = %+v", f)
	}
	old.At = moved.At
	if f := messageSessionFiber(address, []SessionProvenance{moved, old}); f != nil {
		t.Fatalf("conflicting tie accepted: %+v", f)
	}
}

func workerHasHandoff(f *felt.Felt) bool {
	runtime := felt.MappingValueNode(f.ExtraFields["shuttle"], "runtime")
	return felt.MappingValueNode(runtime, "handed_off_at") != nil
}

func TestWorkerLedgerPathRequiresMatchingUID(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	_, st := newStore(t)
	seedShuttleRole(t, st, "f", felt.StatusActive, oneshot(), nil)
	a := newApp(env)
	if _, err := a.workerBindingFiber(SessionProvenance{FiberPath: st.Path("f"), UID: "wrong"}); err == nil {
		t.Fatal("mismatched ledger path accepted")
	}
	if _, err := a.workerBindingFiber(SessionProvenance{FiberPath: filepath.Join("relative", "f.md")}); err == nil {
		t.Fatal("relative ledger path accepted")
	}
}
