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
	dir, storage := newStore(t)
	t.Setenv("SHUTTLE_HOST", "test-host")
	t.Setenv("CODEX_THREAD_ID", "native-thread")
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
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)
	out, stderr, err := executeCLI(t, dir, "-C", dir, "claim", "setup", "--json")
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
	dir, storage := newStore(t)
	t.Setenv("SHUTTLE_HOST", "test-host")
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
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)
	t.Setenv("CLAUDE_CODE_SESSION_ID", "claude-session")
	old := claimTmuxSession
	t.Cleanup(func() { claimTmuxSession = old })
	claimTmuxSession = func() (string, error) { return "exact-session", nil }
	_, _, err := executeCLI(t, dir, "-C", dir, "claim", "setup")
	if err == nil || !strings.Contains(err.Error(), "do not activate") {
		t.Fatalf("rejection %v", err)
	}
	if len(calls) != 1 || mustRead(t, storage, "setup").Status != "open" {
		t.Fatal("rejection activated task")
	}
	claimTmuxSession = old
	t.Setenv("TMUX", "")
	_, _, err = executeCLI(t, dir, "-C", dir, "claim", "setup")
	if err == nil || !strings.Contains(err.Error(), "leave the task as a draft") || len(calls) != 1 {
		t.Fatalf("unsupported identity %v calls %v", err, calls)
	}
	_, _, err = executeCLI(t, dir, "-C", dir, "claim", "setup", "--surface", "app", "--session", "other-thread")
	if err == nil || len(calls) != 1 {
		t.Fatal("surface mismatch reached daemon")
	}
	t.Setenv("SHUTTLE_HOST", "wrong-host")
	_, _, err = executeCLI(t, dir, "-C", dir, "claim", "setup", "--tmux-session", "exact-session")
	if err == nil || len(calls) != 1 {
		t.Fatal("wrong-host claim reached daemon")
	}
}

func TestClaimTmuxInferenceRequiresExactPane(t *testing.T) {
	t.Setenv("TMUX", "/tmp/socket,1,0")
	t.Setenv("TMUX_PANE", "")
	if _, err := claimTmuxSession(); err == nil || !strings.Contains(err.Error(), "pane is unknown") {
		t.Fatalf("inherited TMUX must not select an arbitrary session: %v", err)
	}
}
