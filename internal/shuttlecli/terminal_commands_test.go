package shuttlecli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRexHandoffClosesOnlyOwnBoundBlockAfterWrite(t *testing.T) {
	t.Parallel()
	for _, mode := range []string{"own", "other-block", "unbound-native", "mismatched-native"} {
		t.Run(mode, func(t *testing.T) {
			env := testEnv(t)
			dir, st := newStore(t)
			seedShuttleRole(t, st, "own", "active", oneshot(), nil)
			seedShuttleRole(t, st, "other", "active", oneshot(), nil)
			f := mustRead(t, st, "own")
			name := shuttleTmuxSessionName(f.ID, f.UID)
			env.Chdir(dir)
			env.Set("SHUTTLE_HOST", "test-host")
			env.Set("SHUTTLE_FIBER_PATH", f.Path)
			env.Set("REX_SESSION", "session:own")
			env.Set("REX_BLOCK", "block:own")
			writeRexBindings(t, env, map[string]rexBinding{name: {SessionID: "session:own", BlockID: "block:own", CreatedAt: "stamp"}})
			log := stubRex(t, env, `{"sessions":[]}`, 0)
			snapshot := filepath.Join(t.TempDir(), "snapshot.md")
			env.Set("REX_TEST_FIBER", f.Path)
			env.Set("REX_TEST_SNAPSHOT", snapshot)
			if mode == "other-block" {
				env.Set("REX_BLOCK", "block:human")
			}
			if mode == "unbound-native" {
				env.Set("CODEX_THREAD_ID", "unknown-child")
			}
			if mode == "mismatched-native" {
				other := mustRead(t, st, "other")
				env.Set("CODEX_THREAD_ID", "other-native")
				writeMessageIdentityLedger(t, env, []SessionProvenance{{Host: "test-host", Harness: "codex", Session: "other-native", Fiber: other.ID, UID: other.UID, FiberPath: other.Path, Kind: "claim", At: 1}})
			}
			a := newApp(env)
			if mode == "own" {
				if _, _, err := executeApp(t, a, dir, "-C", dir, "handoff"); err != nil {
					t.Fatal(err)
				}
				data, err := os.ReadFile(snapshot)
				if err != nil || !strings.Contains(string(data), "handed_off_at:") || !workerHasHandoff(mustRead(t, st, "own")) {
					t.Fatalf("handoff was not durable before close: %s %v", data, err)
				}
			} else {
				a.endOwnTerminal()
			}
			calls, err := os.ReadFile(log)
			if mode == "own" {
				if err != nil || !strings.Contains(string(calls), "api call -s session:own session.destroy -") {
					t.Fatalf("own session not closed %s %v", calls, err)
				}
			} else if !os.IsNotExist(err) {
				t.Fatalf("non-owner closed session: %s %v", calls, err)
			}
		})
	}
}

func TestAttachSummaryIsBackendNeutral(t *testing.T) {
	t.Parallel()
	if got := testApp(t).attachCmd().Short; got != "Attach to a running worker's terminal" {
		t.Fatalf("attach summary = %q", got)
	}
}

func TestRexAttachOpensThroughDaemonAndRejectsSSH(t *testing.T) {
	t.Parallel()
	for _, mode := range []string{"local", "ssh", "refused", "prepared-viewer"} {
		t.Run(mode, func(t *testing.T) {
			env := testEnv(t)
			dir, st := newStore(t)
			seedShuttleRole(t, st, "task", "active", oneshot(), nil)
			f := mustRead(t, st, "task")
			name := shuttleTmuxSessionName(f.ID, f.UID)
			if mode == "ssh" {
				env.Set("SSH_CONNECTION", "remote connection")
			}
			a := newApp(env)
			live := map[string]bool{name: true}
			if mode == "prepared-viewer" {
				live = map[string]bool{"codex-terminal-thread": true}
			}
			a.terminals = []terminalBackend{&stubTerminal{id: "rex", live: live}}
			var calls []string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls = append(calls, r.URL.Path)
				if r.Method != "POST" {
					t.Errorf("request %s", r.Method)
				}
				if r.URL.Path == "/api/v1/sessions/prepare-terminal" {
					w.Write([]byte(`{"tmux_session":"codex-terminal-thread"}`))
					return
				}
				if r.URL.Path != "/api/v1/attach" {
					t.Errorf("unexpected route %s", r.URL.Path)
				}
				var payload map[string]string
				json.NewDecoder(r.Body).Decode(&payload)
				want := name
				if mode == "prepared-viewer" {
					want = "codex-terminal-thread"
				}
				if payload["tmux_session"] != want {
					t.Errorf("payload %v", payload)
				}
				if mode == "refused" {
					w.WriteHeader(422)
					w.Write([]byte(`{"error":"cannot reveal"}`))
					return
				}
				w.Write([]byte(`{"ok":true}`))
			}))
			defer server.Close()
			env.Set("SHUTTLE_DAEMON_URL", server.URL)
			out, _, err := executeApp(t, a, dir, "-C", dir, "attach", "task")
			switch mode {
			case "ssh":
				if err == nil || !strings.Contains(err.Error(), "Rex client") || len(calls) != 0 {
					t.Fatalf("SSH %q %v %v", out, err, calls)
				}
			case "refused":
				if err == nil || strings.Contains(out, "Opened") {
					t.Fatalf("false success %q %v", out, err)
				}
			default:
				if err != nil || !strings.Contains(out, " in Rex.") || calls[len(calls)-1] != "/api/v1/attach" {
					t.Fatalf("open %q %v %v", out, err, calls)
				}
			}
		})
	}
}
