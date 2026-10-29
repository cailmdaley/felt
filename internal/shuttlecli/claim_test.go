package shuttlecli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestClaimUsesExistingAppIdentityAndNeverActivates(t *testing.T) {
	t.Parallel()
	dir, storage := newStore(t)
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "test-host")
	env.Set("CODEX_THREAD_ID", "native-thread")
	seedShuttleRole(t, storage, "setup", "open", map[string]any{"kind": "oneshot", "agent": "codex-sol", "host": "test-host", "surface": "app", "project_dir": dir}, nil)
	var calls []string
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.URL.Path)
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"claimed":true,"surface":"app","session_uuid":"native-thread"}`))
	}))
	defer server.Close()
	env.Set("SHUTTLE_DAEMON_URL", server.URL)
	out, stderr, err := executeIn(t, env, dir, "-C", dir, "claim", "setup", "--json")
	if err != nil {
		t.Fatalf("claim %v %s", err, stderr)
	}
	if !strings.Contains(out, `"claimed": true`) || body["session_uuid"] != "native-thread" || body["surface"] != "app" || body["agent"] != "codex-sol" {
		t.Fatalf("response %s payload %v", out, body)
	}
	if !reflect.DeepEqual(calls, []string{"/api/v1/claim"}) {
		t.Fatalf("unexpected activation %v", calls)
	}
	if mustRead(t, storage, "setup").Status != "open" {
		t.Fatal("claim activated task")
	}
}

func TestClaimTerminalInferenceRejectionAndUnsupportedIdentity(t *testing.T) {
	t.Parallel()
	dir, storage := newStore(t)
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "test-host")
	seedShuttleRole(t, storage, "setup", "open", map[string]any{"kind": "oneshot", "agent": "claude-opus", "host": "test-host", "surface": "cli", "project_dir": dir}, nil)
	var calls []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.URL.Path)
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["tmux_session"] != "exact-session" || body["session_uuid"] != "claude-session" {
			t.Errorf("wrong identity %v", body)
		}
		w.WriteHeader(422)
		w.Write([]byte(`{"claimed":false,"reason":"session_not_found"}`))
	}))
	defer server.Close()
	env.Set("SHUTTLE_DAEMON_URL", server.URL)
	env.Set("CLAUDE_CODE_SESSION_ID", "claude-session")
	stubWorkerExitTmux(t, env, "exact-session", storage.Path("setup"))
	inTmux := newApp(env)
	_, _, err := executeApp(t, inTmux, dir, "-C", dir, "claim", "setup")
	if err == nil || !strings.Contains(err.Error(), "do not activate") {
		t.Fatalf("rejection %v", err)
	}
	if len(calls) != 1 || mustRead(t, storage, "setup").Status != "open" {
		t.Fatal("rejection activated task")
	}
	env.Set("TMUX", "")
	_, _, err = executeIn(t, env, dir, "-C", dir, "claim", "setup")
	if err == nil || !strings.Contains(err.Error(), "leave the task as a draft") || len(calls) != 1 {
		t.Fatalf("unsupported identity %v calls %v", err, calls)
	}
	_, _, err = executeIn(t, env, dir, "-C", dir, "claim", "setup", "--surface", "app", "--session", "other-thread")
	if err == nil || len(calls) != 1 {
		t.Fatal("surface mismatch reached daemon")
	}
	env.Set("SHUTTLE_HOST", "wrong-host")
	_, _, err = executeIn(t, env, dir, "-C", dir, "claim", "setup", "--tmux-session", "exact-session")
	if err == nil || len(calls) != 1 {
		t.Fatal("wrong-host claim reached daemon")
	}
}

func TestClaimTmuxInferenceRequiresExactPane(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("TMUX", "/tmp/socket,1,0")
	env.Set("TMUX_PANE", "")
	if _, err := newApp(env).currentTerminal(); err == nil || !strings.Contains(err.Error(), "pane is unknown") {
		t.Fatalf("inherited TMUX must not select an arbitrary session: %v", err)
	}
}

func TestClaimRexSendsExactNativeCoordinates(t *testing.T) {
	t.Parallel()
	dir, st := newStore(t)
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "test-host")
	env.Set("REX_SESSION", "session:human")
	env.Set("REX_BLOCK", "block:human")
	env.Set("CLAUDE_CODE_SESSION_ID", "native-conversation")
	env.Set("PATH", "")
	seedShuttleRole(t, st, "draft", "open", map[string]any{"kind": "oneshot", "agent": "claude-opus", "host": "test-host", "surface": "cli", "project_dir": dir}, nil)
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/claim" {
			t.Errorf("unexpected route %s", r.URL.Path)
		}
		json.NewDecoder(r.Body).Decode(&body)
		w.Write([]byte(`{"claimed":true}`))
	}))
	defer server.Close()
	env.Set("SHUTTLE_DAEMON_URL", server.URL)
	if _, _, err := executeIn(t, env, dir, "-C", dir, "claim", "draft"); err != nil {
		t.Fatal(err)
	}
	if body["tmux_session"] != "session:human" || body["tmux_pane"] != "block:human" || body["session_uuid"] != "native-conversation" {
		t.Fatalf("wrong claim coordinates %v", body)
	}
	if mustRead(t, st, "draft").Status != "open" {
		t.Fatal("claim activated task")
	}
}
