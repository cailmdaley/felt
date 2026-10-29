package shuttlecli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestMigrateRoutesIdentityWithoutLocalLifecycleWrites(t *testing.T) {
	t.Parallel()
	for _, mode := range []string{"", "--rest", "--disabled", "codex", "rex", "rex-codex"} {
		t.Run(mode, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			dir, st := newStore(t)
			env.Set("SHUTTLE_HOST", "testhost")
			env.Set("CLAUDE_CODE_SESSION_ID", "live-session")
			env.Set("TMUX", "/tmp/test-socket,1,0")
			env.Set("TMUX_PANE", "%17")
			if strings.HasPrefix(mode, "rex") {
				env.Unset("TMUX")
				env.Unset("TMUX_PANE")
				env.Set("REX_SESSION", "session:source")
				env.Set("REX_BLOCK", "block:source")
			}
			if strings.Contains(mode, "codex") {
				env.Unset("CLAUDE_CODE_SESSION_ID")
				env.Set("CODEX_THREAD_ID", "live-session")
			}
			for _, id := range []string{"from", "to"} {
				seedShuttleRole(t, st, id, "active", map[string]any{"kind": "oneshot", "host": "testhost", "agent": "claude-opus", "project_dir": dir}, nil)
			}
			var body map[string]any
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/v1/migrate" {
					t.Errorf("unexpected route %s", r.URL.Path)
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				w.Write([]byte(`{"ok":true,"from":"from","to":"to","session_uuid":"live-session"}`))
			}))
			defer server.Close()
			env.Set("SHUTTLE_DAEMON_URL", server.URL)
			args := []string{"migrate", "to", "--from", "from", "--json"}
			if strings.HasPrefix(mode, "--") {
				args = append(args, mode)
			}
			out, err := runIn(t, env, dir, args...)
			if err != nil {
				t.Fatalf("%v: %s", err, out)
			}
			wantPane := "%17"
			if mode == "rex" {
				wantPane = "block:source"
			}
			if strings.Contains(mode, "codex") {
				wantPane = ""
			}
			if body["from"] != "from" || body["to"] != "to" || body["session_id"] != "live-session" || body["tmux_pane"] != wantPane || body["rest"] != (mode == "--rest") || body["disabled"] != (mode == "--disabled") {
				t.Fatalf("payload %+v", body)
			}
			if !strings.Contains(out, `"ok": true`) {
				t.Fatal(out)
			}
			if mustRead(t, st, "from").Status != felt.StatusActive {
				t.Fatal("CLI wrote source lifecycle outside Poller")
			}
		})
	}
}

func TestExitHelpNamesEnvironmentOnlyMigrationLimit(t *testing.T) {
	t.Parallel()
	dir, _ := newStore(t)
	for _, verb := range []string{"handoff", "close", "rest"} {
		out, err := runIn(t, testEnv(t), dir, verb, "--help")
		if err != nil || !strings.Contains(out, "pass the destination fiber explicitly") || !strings.Contains(out, "SHUTTLE_FIBER_PATH") {
			t.Fatalf("%s help does not explain migration identity limit: %v %s", verb, err, out)
		}
	}
}

func TestMigrateInfersSourceFromWorkerContext(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, st := newStore(t)
	env.Set("SHUTTLE_HOST", "testhost")
	for _, id := range []string{"source", "destination"} {
		seedShuttleRole(t, st, id, "active", map[string]any{"kind": "oneshot", "host": "testhost", "agent": "claude-opus"}, nil)
	}
	env.Set("SHUTTLE_FIBER_PATH", st.Path("source"))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["from"] != "source" || body["to"] != "destination" {
			t.Errorf("payload %+v", body)
		}
		w.Write([]byte(`{"ok":true,"session_uuid":"moved"}`))
	}))
	defer server.Close()
	env.Set("SHUTTLE_DAEMON_URL", server.URL)
	if out, err := runIn(t, env, dir, "migrate", "destination"); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
}

func TestMigrateRefusesInvalidOptionsInstallationAndHost(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, st := newStore(t)
	env.Set("SHUTTLE_HOST", "testhost")
	seedShuttleRole(t, st, "from", "active", map[string]any{"kind": "oneshot", "host": "testhost", "agent": "claude-opus"}, nil)
	seedShuttleRole(t, st, "remote", "open", map[string]any{"kind": "oneshot", "host": "elsewhere", "agent": "claude-opus"}, nil)
	seedPlainFiber(t, st, "plain", "")
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"migrate", "plain", "--from", "from"}, "not_installed"},
		{[]string{"migrate", "remote", "--from", "from"}, "other_host"},
		{[]string{"migrate", "from", "--from", "from", "--rest", "--disabled"}, "incompatible"},
	} {
		if _, err := runIn(t, env, dir, tc.args...); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%v: %v; want %s", tc.args, err, tc.want)
		}
	}
}

func TestMigrateReportsDaemonRefusalAndUnconfirmedResponse(t *testing.T) {
	t.Parallel()
	for _, response := range []struct {
		status     int
		body, want string
	}{
		{422, `{"ok":false,"reason":"already_running","error":"pause destination or choose another fiber"}`, "already_running"},
		{200, `{"ok":false,"reason":"same_fiber"}`, "same_fiber"},
		{200, `not json`, "response unreadable"},
	} {
		t.Run(response.want, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			dir, st := newStore(t)
			env.Set("SHUTTLE_HOST", "testhost")
			for _, id := range []string{"from", "to"} {
				seedShuttleRole(t, st, id, "active", map[string]any{"kind": "oneshot", "host": "testhost", "agent": "claude-opus"}, nil)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(response.status)
				w.Write([]byte(response.body))
			}))
			defer server.Close()
			env.Set("SHUTTLE_DAEMON_URL", server.URL)
			if _, err := runIn(t, env, dir, "migrate", "to", "--from", "from"); err == nil || !strings.Contains(err.Error(), response.want) {
				t.Fatalf("%v", err)
			}
		})
	}
}
