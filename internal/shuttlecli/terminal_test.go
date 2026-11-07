package shuttlecli

import (
	"bytes"
	"encoding/json"
	"errors"
	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/cailmdaley/felt/internal/sysenv"
)

type stubTerminal struct {
	id     string
	live   map[string]bool
	killed *[]string
	err    error
}

func (s *stubTerminal) ID() string                            { return s.id }
func (s *stubTerminal) Has(name string) (bool, error)         { return s.live[name], s.err }
func (s *stubTerminal) LiveWorkers() (map[string]bool, error) { return s.live, s.err }
func (s *stubTerminal) Kill(name string) error {
	if s.killed != nil {
		*s.killed = append(*s.killed, name)
	}
	return s.err
}

func writeRexBindings(t *testing.T, env *sysenv.Env, bindings map[string]rexBinding) string {
	t.Helper()
	dir, err := shuttle.DataDir(env)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "terminals", "rex.json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	server := "isolated-server"
	data, err := json.Marshal(rexBindingIndex{Version: 1, Server: &server, Bindings: bindings})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func stubRex(t *testing.T, env *sysenv.Env, sessions string, exit int) string {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "calls")
	bin := filepath.Join(dir, "rex")
	script := `#!/bin/sh
printf '%s\n' "$*" >> "$REX_TEST_CALLS"
case "$*" in
  *'ls --json') printf '%s\n' "$REX_TEST_SESSIONS"; exit "$REX_TEST_EXIT" ;;
  *'session.list_blocks -') cat >/dev/null; printf '%s\n' "$REX_TEST_BLOCKS" ;;
  *'session.destroy -')
    cat >/dev/null
    if [ -n "$REX_TEST_FIBER" ]; then cp "$REX_TEST_FIBER" "$REX_TEST_SNAPSHOT" || exit 1; fi
    printf '{}\n' ;;
  *'session.close_window -'|*'block.close -') cat >> "$REX_TEST_CALLS"; printf '\n{}\n' ;;
  *) exit 99 ;;
esac
`
	sysenvtest.LinkScript(t, bin, script)
	env.Set("SHUTTLE_REX_BIN", bin)
	env.Set("SHUTTLE_REX_SERVER", "unix:///tmp/test-isolated-rex.sock")
	env.Set("REX_TEST_CALLS", log)
	env.Set("REX_TEST_SESSIONS", sessions)
	env.Set("REX_TEST_EXIT", string(rune('0'+exit)))
	env.Set("REX_TEST_BLOCKS", `{"blocks":[{"block_id":"block:bound","window_id":"window:main"},{"block_id":"block:own","window_id":"window:main"}]}`)
	return log
}

func TestTmuxKillUsesExactName(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	bin := t.TempDir()
	sysenvtest.LinkScript(t, filepath.Join(bin, "tmux"), "#!/bin/sh\n[ \"$1 $2 $3\" = 'kill-session -t =missing' ]\n")
	env.Set("PATH", bin)
	if err := (&tmuxTerminal{a: newApp(env)}).Kill("missing"); err != nil {
		t.Fatalf("kill must use an exact name: %v", err)
	}
}

func TestTmuxDollarNamesDoNotAddressNativeIDs(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	bin := t.TempDir()
	sysenvtest.LinkScript(t, filepath.Join(bin, "tmux"), "#!/bin/sh\ncase \"$1\" in\nls) printf '$0\\tvictim\\n$1\\t$0\\n';;\nhas-session|kill-session) [ \"$3\" = '$1' ];;\n*) exit 99;;\nesac\n")
	env.Set("PATH", bin)
	terminal := &tmuxTerminal{a: newApp(env)}
	if present, err := terminal.Has("$0"); !present || err != nil {
		t.Fatalf("literal name was not resolved: %v %v", present, err)
	}
	if err := terminal.Kill("$0"); err != nil {
		t.Fatalf("literal name was not closed by its ID: %v", err)
	}
	if present, _ := terminal.Has("$1"); present {
		t.Fatal("a native ID was mistaken for a name")
	}
	if err := terminal.Kill("$1"); err == nil {
		t.Fatal("an absent literal name was killed as a native ID")
	}
}

func TestTerminalBackendsAndMixedHolders(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	bin := t.TempDir()
	sysenvtest.LinkScript(t, filepath.Join(bin, "tmux"), "#!/bin/sh\nexit 0\n")
	env.Set("PATH", bin)
	if err := os.WriteFile(env.Getenv("SHUTTLE_HOST_CONFIG_FILE"), []byte(`{"terminal":"rex"}`), 0600); err != nil {
		t.Fatal(err)
	}
	a := newApp(env)
	backends, err := a.terminalBackends()
	if err != nil || len(backends) != 2 || backends[0].ID() != "rex" || backends[1].ID() != "tmux" {
		t.Fatalf("backends %v: %v", backends, err)
	}
	var rk, tk []string
	a.terminals = []terminalBackend{&stubTerminal{id: "rex", live: map[string]bool{"new": true}, killed: &rk}, &stubTerminal{id: "tmux", live: map[string]bool{"old": true}, killed: &tk}}
	for name, want := range map[string]bool{"old": true, "new": true, "absent": false} {
		if present, err := a.terminalSessionExists(name); present != want || err != nil {
			t.Fatalf("%s: %v %v", name, present, err)
		}
	}
	if got, err := a.liveTerminalSessions(); err != nil || !reflect.DeepEqual(got, map[string]bool{"old": true, "new": true}) {
		t.Fatal(got)
	}
	if err := a.killTerminalSession("old"); err != nil {
		t.Fatal(err)
	}
	if len(rk) != 0 || !reflect.DeepEqual(tk, []string{"old"}) {
		t.Fatalf("wrong holder killed: %v %v", rk, tk)
	}
	a.terminals = []terminalBackend{&stubTerminal{id: "rex", err: errors.New("timeout")}, &stubTerminal{id: "tmux", live: map[string]bool{"old": true}}}
	if present, err := a.terminalSessionExists("old"); !present || err != nil {
		t.Fatalf("primary uncertainty hid a known secondary: %v %v", present, err)
	}
	if err := a.killTerminalSession("missing"); err == nil {
		t.Fatal("uncertain holder was killed")
	}
}

func TestTerminalObservationHostConfigFallback(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, config         string
		warning, badTerminal bool
	}{
		{"malformed", `{"terminal":`, true, false},
		{"not an object", `[]`, true, false},
		{"null document", `null`, true, false},
		{"unreadable", "", true, false},
		{"missing key", `{}`, false, false},
		{"unrelated invalid setting", `{"class":42}`, false, false},
		{"explicit tmux", `{"terminal":"tmux"}`, false, false},
		{"unknown terminal", `{"terminal":"other"}`, false, true},
		{"null terminal", `{"terminal":null}`, false, true},
		{"nonstring terminal", `{"terminal":42}`, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := testEnv(t)
			configPath := env.Getenv("SHUTTLE_HOST_CONFIG_FILE")
			if tc.config == "" {
				if err := os.MkdirAll(configPath, 0700); err != nil {
					t.Fatal(err)
				}
			} else if err := os.WriteFile(configPath, []byte(tc.config), 0600); err != nil {
				t.Fatal(err)
			}
			bin := t.TempDir()
			const name = "task-01ARZ3NDEKTSV4RRFFQ69G5FAV-shuttle"
			script := "#!/bin/sh\ncase \"$1\" in\nls) printf '%s\\n' '" + name + "';;\nhas-session|kill-session) exit 0;;\n*) exit 99;;\nesac\n"
			sysenvtest.LinkScript(t, filepath.Join(bin, "tmux"), script)
			env.Set("PATH", bin)
			var stdout, stderr bytes.Buffer
			env.Stdout, env.Stderr = &stdout, &stderr
			a := newApp(env)
			backends, err := a.terminalBackends()
			if tc.badTerminal {
				if !isHostConfigError(err, "bad_terminal") || stderr.Len() != 0 {
					t.Fatalf("unknown terminal: %v, stderr=%q", err, stderr.String())
				}
				return
			}
			if err != nil || len(backends) != 1 || backends[0].ID() != "tmux" {
				t.Fatalf("backends=%v error=%v", backends, err)
			}
			if live, err := a.terminalSessionExists(name); !live || err != nil {
				t.Fatalf("session observation: %v %v", live, err)
			}
			if live, err := a.liveTerminalSessions(); !live[name] || err != nil {
				t.Fatalf("worker listing: %v %v", live, err)
			}
			if err := a.killTerminalSession(name); err != nil {
				t.Fatal(err)
			}
			if stdout.Len() != 0 {
				t.Fatalf("warning leaked to stdout: %q", stdout.String())
			}
			if tc.warning {
				if strings.Count(stderr.String(), "warning:") != 1 || !strings.Contains(stderr.String(), configPath) || !strings.Contains(stderr.String(), "tmux") {
					t.Fatalf("fallback warning=%q", stderr.String())
				}
				if _, err := a.hostTerminal(); err == nil {
					t.Fatal("strict host configuration reader accepted malformed input")
				}
			} else if stderr.Len() != 0 {
				t.Fatalf("unexpected warning: %q", stderr.String())
			}
		})
	}
}

func TestCurrentTerminalRexReadsBindingWithoutSpawn(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("PATH", "")
	env.Set("REX_SESSION", "session:own")
	env.Set("REX_BLOCK", "block:own")
	name := "task-01ARZ3NDEKTSV4RRFFQ69G5FAV-shuttle"
	path := writeRexBindings(t, env, map[string]rexBinding{name: {SessionID: "session:own", BlockID: "block:own", CreatedAt: "stamp"}})
	a := newApp(env)
	ref, err := a.currentTerminal()
	if err != nil || ref.Backend != "rex" || ref.Name != name || ref.NativeSession != "session:own" || ref.NativePane != "block:own" {
		t.Fatalf("ref %+v: %v", ref, err)
	}
	if got := a.currentTmuxSession(); got != name {
		t.Fatalf("hook identity %q", got)
	}
	// A different block in the same session is not this worker.
	env.Set("REX_BLOCK", "block:human")
	ref, err = a.currentTerminal()
	if err != nil || ref.Name != "" {
		t.Fatalf("human pane inherited worker %+v: %v", ref, err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	ref, err = a.currentTerminal()
	if err != nil || ref.Name != "" || ref.NativeSession != "session:own" {
		t.Fatalf("unbound human %+v: %v", ref, err)
	}
}

func TestRexBindingReadAndTerminalObservations(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	name := "task-01ARZ3NDEKTSV4RRFFQ69G5FAV-shuttle"
	other := "recover-01ARZ3NDEKTSV4RRFFQ69G5FAW-shuttle"
	stale := "stale-01ARZ3NDEKTSV4RRFFQ69G5FAX-shuttle"
	path := writeRexBindings(t, env, map[string]rexBinding{
		name:  {SessionID: "session:bound", BlockID: "block:bound", CreatedAt: "stamp"},
		stale: {SessionID: "session:stale", BlockID: "block:stale", CreatedAt: "stamp"},
	})
	before, _ := os.ReadFile(path)
	log := stubRex(t, env, `{"sessions":[{"session_id":"session:bound","label":"renamed display"},{"session_id":"session:recover","label":"`+other+`"}]}`, 0)
	env.Set("REX_TEST_BLOCKS", `{"blocks":[{"block_id":"block:bound","window_id":"window:own"},{"block_id":"block:recover","label":"`+other+`","window_id":"window:own"}]}`)
	r := &rexTerminal{a: newApp(env)}
	if has, err := r.Has(name); !has || err != nil {
		t.Fatalf("renamed binding %v %v", has, err)
	}
	if has, err := r.Has(stale); has || err != nil {
		t.Fatalf("stale binding %v %v", has, err)
	}
	if has, err := r.Has(other); has || err != nil {
		t.Fatalf("unbound label is not a kill address %v %v", has, err)
	}
	live, err := r.LiveWorkers()
	if err != nil || !reflect.DeepEqual(live, map[string]bool{name: true, other: true}) {
		t.Fatalf("live %v: %v", live, err)
	}
	if err := r.Kill(name); err != nil {
		t.Fatal(err)
	}
	calls, _ := os.ReadFile(log)
	if !strings.Contains(string(calls), "--autostart=false --timeout 5s -S unix:///tmp/test-isolated-rex.sock api call -s session:bound session.destroy -") {
		t.Fatalf("wrong destruction %s", calls)
	}
	if err := r.Kill(other); err == nil {
		t.Fatal("destroyed unbound label")
	}
	env.Set("REX_TEST_BLOCKS", `{"blocks":[{"block_id":"block:human"}]}`)
	if has, err := r.Has(name); has || err != nil {
		t.Fatalf("human pane replaced worker: %v %v", has, err)
	}
	if err := os.Remove(log); err != nil {
		t.Fatal(err)
	}
	if err := r.Kill(name); err != nil {
		t.Fatal(err)
	}
	calls, _ = os.ReadFile(log)
	if strings.Contains(string(calls), "session.destroy") {
		t.Fatalf("destroyed surviving human pane: %s", calls)
	}
	if err := os.Remove(log); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	env.Set("REX_TEST_BLOCKS", `{"blocks":[{"block_id":"block:bound","window_id":"window:own"},{"block_id":"block:sibling","window_id":"window:sibling"}]}`)
	if err := r.Kill(name); err != nil {
		t.Fatal(err)
	}
	calls, _ = os.ReadFile(log)
	if strings.Contains(string(calls), "session.destroy") || !strings.Contains(string(calls), `session.close_window -`) || !strings.Contains(string(calls), `{"window_id":"window:own"}`) {
		t.Fatalf("a family member must close only its window: %s", calls)
	}
	// A worker the daemon took out of view is detached: Rex lists its block
	// without a window, so only that block closes, or the session it is alone in.
	if err := os.Remove(log); err != nil {
		t.Fatal(err)
	}
	env.Set("REX_TEST_BLOCKS", `{"blocks":[{"block_id":"block:bound","placement":"detached"},{"block_id":"block:sibling","window_id":"window:sibling"},{"block_id":"block:hidden","placement":"detached"}]}`)
	if err := r.Kill(name); err != nil {
		t.Fatal(err)
	}
	calls, _ = os.ReadFile(log)
	if strings.Contains(string(calls), "session.destroy") || strings.Contains(string(calls), "session.close_window") || !strings.Contains(string(calls), "session:bound block.close -\n"+`{"block_id":"block:bound"}`) {
		t.Fatalf("a detached family member must close only its block: %s", calls)
	}
	if err := os.Remove(log); err != nil {
		t.Fatal(err)
	}
	env.Set("REX_TEST_BLOCKS", `{"blocks":[{"block_id":"block:bound","placement":"detached"}]}`)
	if err := r.Kill(name); err != nil {
		t.Fatal(err)
	}
	calls, _ = os.ReadFile(log)
	if !strings.Contains(string(calls), "session:bound session.destroy -") || strings.Contains(string(calls), "block.close") {
		t.Fatalf("a detached worker alone in its session must take the session: %s", calls)
	}
	env.Set("REX_TEST_BLOCKS", `{"blocks":[{"block_id":"block:bound"}]}`)
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("CLI changed daemon-owned bindings")
	}
	for _, code := range []string{"4", "1"} {
		env.Set("REX_TEST_EXIT", code)
		has, err := r.Has(name)
		if has || (code == "4" && err != nil) || (code == "1" && err == nil) {
			t.Fatalf("exit %s: %v %v", code, has, err)
		}
	}
	env.Set("REX_TEST_EXIT", "0")
	env.Set("REX_TEST_SESSIONS", `{}`)
	if _, err := r.Has(name); err == nil {
		t.Fatal("malformed session list accepted")
	}
	for _, data := range []string{`null`, `{}`, `{"version":2,"bindings":{}}`, `{"version":1,"bindings":{"x":{"session_id":"human"}}}`} {
		if err := os.WriteFile(path, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := r.bindings(); err == nil {
			t.Fatalf("invalid index accepted: %s", data)
		}
	}
}

func TestRexEndpointParity(t *testing.T) {
	t.Parallel()
	data, err := os.ReadFile("../../daemon/test/fixtures/rex/endpoints.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct{ Name, OS, Home, Data, Override, Want string }
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			env.Set("HOME", tc.Home)
			env.Set("SHUTTLE_DATA_DIR", tc.Data)
			env.Set("SHUTTLE_REX_SERVER", tc.Override)
			a := newApp(env)
			a.hostGOOS = tc.OS
			got, err := a.rexServer()
			if err != nil || got != tc.Want {
				t.Fatalf("endpoint = %q, %v; want %q", got, err, tc.Want)
			}
			// Check the command actually uses the resolved endpoint with autostart off.
			bin := filepath.Join(t.TempDir(), "rex")
			sysenvtest.LinkScript(t, bin, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n")
			env.Set("SHUTTLE_REX_BIN", bin)
			out, err := (&rexTerminal{a: a}).command("", "whoami", "--json")
			want := "--autostart=false\n--timeout\n5s\n"
			if tc.Want != "" {
				want += "-S\n" + tc.Want + "\n"
			}
			want += "whoami\n--json\n"
			if err != nil || string(out) != want {
				t.Fatalf("command: %q, %v; want %q", out, err, want)
			}
		})
	}
}
