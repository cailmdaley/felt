package shuttlecli

import (
	"os"
	"strings"
	"testing"
)

func TestRexListingRequiresWorkerBlockAndDoesNotReintroduceDisplayLabel(t *testing.T) {
	t.Parallel()
	for _, bound := range []bool{true, false} {
		t.Run(map[bool]string{true: "bound", false: "lost-binding"}[bound], func(t *testing.T) {
			env := testEnv(t)
			name := "departed-01ARZ3NDEKTSV4RRFFQ69G5FAV-shuttle"
			bindings := map[string]rexBinding{}
			if bound {
				bindings[name] = rexBinding{SessionID: "session:lingering", BlockID: "block:worker", CreatedAt: "stamp"}
			}
			writeRexBindings(t, env, bindings)
			stubRex(t, env, `{"sessions":[{"session_id":"session:lingering","label":"`+name+`"}]}`, 0)
			env.Set("REX_TEST_BLOCKS", `{"blocks":[{"block_id":"block:human","label":"human shell"}]}`)
			r := &rexTerminal{a: newApp(env)}
			live, err := r.LiveWorkers()
			if err != nil || len(live) != 0 {
				t.Fatalf("departed worker is live: %v %v", live, err)
			}
			// Bound names survive a display rename; display labels never invent
			// another worker for the same session.
			env.Set("REX_TEST_BLOCKS", `{"blocks":[{"block_id":"block:worker","label":"`+name+`"}]}`)
			if bound {
				alias := "display-01ARZ3NDEKTSV4RRFFQ69G5FAW-shuttle"
				env.Set("REX_TEST_SESSIONS", `{"sessions":[{"session_id":"session:lingering","label":"`+alias+`"}]}`)
			}
			live, err = r.LiveWorkers()
			if err != nil || len(live) != 1 || !live[name] {
				t.Fatalf("live worker %v %v", live, err)
			}
		})
	}
}

func TestRexLostBindingListingUsesBlockIdentityUnderTreeDisplay(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	name := "thread-01ARZ3NDEKTSV4RRFFQ69G5FAV-shuttle"
	path := writeRexBindings(t, env, map[string]rexBinding{})
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	stubRex(t, env, `{"sessions":[{"session_id":"session:tree","label":"└ thread"}]}`, 0)
	env.Set("REX_TEST_BLOCKS", `{"blocks":[{"block_id":"block:worker","label":"`+name+`"},{"block_id":"block:viewer","label":"`+name+`@tmux"},{"block_id":"block:human","label":"human"}]}`)
	r := &rexTerminal{a: newApp(env)}
	live, err := r.LiveWorkers()
	if err != nil || len(live) != 1 || !live[name] {
		t.Fatalf("tree display hid live block identity: %v %v", live, err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("read-only discovery wrote bindings: %v", err)
	}
	if err := r.Kill(name); err == nil {
		t.Fatal("discovery became permission to destroy an unbound session")
	}
}

func TestTerminalObservationErrorsReachEveryCLICaller(t *testing.T) {
	t.Parallel()
	for _, args := range [][]string{{"status"}, {"ps"}, {"status", "task"}, {"pause", "task"}, {"rest", "task"}, {"attach", "task"}} {
		t.Run(strings.Join(args, "-"), func(t *testing.T) {
			env := testEnv(t)
			dir, st := newStore(t)
			seedShuttleRole(t, st, "task", "active", oneshot(), nil)
			f := mustRead(t, st, "task")
			name := shuttleTmuxSessionName(f.ID, f.UID)
			writeRexBindings(t, env, map[string]rexBinding{name: {SessionID: "session:worker", BlockID: "block:worker", CreatedAt: "stamp"}})
			log := stubRex(t, env, `{"sessions":[]}`, 1)
			a := newApp(env)
			a.terminals = []terminalBackend{&rexTerminal{a: a}}
			out, _, err := executeApp(t, a, dir, append([]string{"-C", dir}, args...)...)
			if err == nil || !strings.Contains(err.Error(), "observing worker terminal") {
				t.Fatalf("uncertainty became success: %s %v", out, err)
			}
			if strings.Contains(out, "no live") || strings.Contains(out, "Opened") || strings.Contains(out, `"running": false`) {
				t.Fatalf("false absence: %s", out)
			}
			calls, _ := os.ReadFile(log)
			if strings.Contains(string(calls), "session.destroy") {
				t.Fatalf("uncertain observation destroyed terminal: %s", calls)
			}
		})
	}
}

func TestTerminalListingPropagatesBadHostConfiguration(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	if err := os.WriteFile(env.Getenv("SHUTTLE_HOST_CONFIG_FILE"), []byte(`{"terminal":"unknown"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := newApp(env).liveTerminalSessions(); err == nil || !strings.Contains(err.Error(), "invalid terminal") {
		t.Fatalf("configuration error became empty listing: %v", err)
	}
}
