package shuttlecli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
)

func TestRenamedWorkerOfflineLifecycleUsesLaunchName(t *testing.T) {
	t.Parallel()
	for _, backend := range []string{"tmux", "rex"} {
		for _, verb := range []string{"pause", "rest"} {
			t.Run(backend+"/"+verb, func(t *testing.T) {
				t.Parallel()
				env := testEnv(t)
				env.Set("SHUTTLE_DAEMON_URL", "http://127.0.0.1:1")
				dir, st := newStore(t)
				seedShuttleRole(t, st, "new-task", felt.StatusActive, oneshot(), nil)
				f := mustRead(t, st, "new-task")
				original := shuttleTmuxSessionName("old-task", f.UID)
				var killed []string
				a := newApp(env)
				a.terminals = []terminalBackend{&stubTerminal{id: backend, live: map[string]bool{original: true}, killed: &killed}}
				out, _, err := executeApp(t, a, dir, verb, f.ID)
				if err != nil || len(killed) != 1 || killed[0] != original {
					t.Fatalf("%v, killed %v\n%s", err, killed, out)
				}
			})
		}
	}
}

func TestRenamedWorkerRealTmuxStatusAndControl(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	tmux, err := env.LookPath("tmux")
	if err != nil {
		t.Skip("tmux not installed")
	}
	scratch, err := os.MkdirTemp("/tmp", "rename-tmux-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(scratch)
	socket := filepath.Join(scratch, "server.sock")
	env.Set("RENAME_TMUX_BIN", tmux)
	env.Set("RENAME_TMUX_SOCKET", socket)
	sysenvtest.FakeCommand(t, env, "tmux", "exec \"$RENAME_TMUX_BIN\" -S \"$RENAME_TMUX_SOCKET\" -f /dev/null \"$@\"\n")
	defer func() { _ = env.Command(tmux, "-S", socket, "kill-server").Run() }()
	dir, st := newStore(t)
	seedShuttleRole(t, st, "new-task", felt.StatusActive, oneshot(), nil)
	f := mustRead(t, st, "new-task")
	original := shuttleTmuxSessionName("old-task", f.UID)
	unrelated := shuttleTmuxSessionName("old-task", felt.NewULID())
	for _, name := range []string{original, unrelated} {
		if out, err := env.Command("tmux", "new-session", "-d", "-s", name, "sleep 300").CombinedOutput(); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
	}
	a := newApp(env)
	if session, live, err := a.liveWorkerSession(f); err != nil || !live || session != original {
		t.Fatalf("lookup: %q %t %v", session, live, err)
	}
	out, _, err := executeApp(t, a, dir, "status", "--json")
	if err != nil {
		t.Fatalf("status: %v\n%s", err, out)
	}
	var rows []FiberStatus
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || !rows[0].Running || rows[0].Session != original || rows[0].FiberID != f.ID {
		t.Fatalf("status: %+v", rows)
	}
	out, _, err = executeApp(t, a, dir, "ps", "--json")
	if err != nil {
		t.Fatalf("ps: %v\n%s", err, out)
	}
	var workers []map[string]string
	if err := json.Unmarshal([]byte(out), &workers); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, w := range workers {
		if w["session"] == original && w["fiber_id"] == f.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("ps lost renamed owner: %s", out)
	}
	out, _, err = executeApp(t, a, dir, "status", f.ID)
	if err != nil || !strings.Contains(out, original) {
		t.Fatalf("detail: %v\n%s", err, out)
	}
	if err := a.killTerminalSession(original); err != nil {
		t.Fatal(err)
	}
	if session, live, err := a.liveWorkerSession(f); err != nil || live || session != "" {
		t.Fatalf("stopped lookup: %q %t %v", session, live, err)
	}
	if live, err := a.terminalSessionExists(unrelated); err != nil || !live {
		t.Fatalf("unrelated worker: %t %v", live, err)
	}
}
