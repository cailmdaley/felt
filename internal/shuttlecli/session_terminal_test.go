package shuttlecli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestPrepareWorkerTerminalUsesIntrinsicIdentity(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	var payload map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/sessions/prepare-terminal" {
			t.Errorf("request %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"tmux_session":"codex-terminal-exact-thread","created":true}`))
	}))
	defer server.Close()
	env.Set("SHUTTLE_DAEMON_URL", server.URL)
	a, _ := withStubbedTmux(t, env, map[string]bool{})
	session, err := a.prepareWorkerTerminal(&felt.Felt{ID: "renamed/task", UID: "intrinsic-uid"})
	if err != nil || session != "codex-terminal-exact-thread" {
		t.Fatalf("terminal %q: %v", session, err)
	}
	if len(payload) != 1 || payload["fiber"] != "intrinsic-uid" {
		t.Fatalf("payload %#v", payload)
	}
}

func TestPrepareWorkerTerminalNeverFallsBackOnRefusal(t *testing.T) {
	t.Parallel()
	for _, response := range []struct {
		name   string
		status int
		body   string
	}{
		{"lost initial turn", 422, `{"error":"initial_turn_unconfirmed","session_uuid":"exact-thread"}`},
		{"backend unavailable", 422, `{"error":"app_server_unavailable"}`},
		{"old daemon", 404, `{"error":"not found"}`},
		{"missing terminal", 200, `{}`},
	} {
		t.Run(response.name, func(t *testing.T) {
			env := testEnv(t)
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if strings.Contains(r.URL.Path, "dispatch") {
					t.Fatal("attach dispatched a task")
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(response.status)
				w.Write([]byte(response.body))
			}))
			defer server.Close()
			env.Set("SHUTTLE_DAEMON_URL", server.URL)
			a, _ := withStubbedTmux(t, env, map[string]bool{})
			session, err := a.prepareWorkerTerminal(&felt.Felt{ID: "task", UID: "uid"})
			if err == nil || session != "" || calls != 1 {
				t.Fatalf("terminal %q err %v calls %d", session, err, calls)
			}
		})
	}
}
