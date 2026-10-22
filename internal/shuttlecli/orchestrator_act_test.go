package shuttlecli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

// seedOrchestrated writes hub, whose live worker is session "chair-session",
// and its thread hub/t.
func seedOrchestrated(t *testing.T, storage *felt.Storage) {
	t.Helper()
	seedShuttleRole(t, storage, "hub", felt.StatusActive, oneshot(), nil)
	hub := mustRead(t, storage, "hub")
	if err := shuttle.SetRuntimeField(hub, "session_uuid", "chair-session"); err != nil {
		t.Fatal(err)
	}
	if err := storage.Write(hub); err != nil {
		t.Fatal(err)
	}
	seedShuttleRole(t, storage, "hub/t", felt.StatusActive, oneshot(), nil)
}

func orchestratorActed(t *testing.T, storage *felt.Storage, id string) string {
	t.Helper()
	runtime := felt.MappingValueNode(mustRead(t, storage, id).ExtraFields["shuttle"], "runtime")
	if node := felt.MappingValueNode(runtime, orchestratorActedKey); node != nil {
		return node.Value
	}
	return ""
}

func runtimeValue(t *testing.T, storage *felt.Storage, id, key string) string {
	t.Helper()
	runtime := felt.MappingValueNode(mustRead(t, storage, id).ExtraFields["shuttle"], "runtime")
	if node := felt.MappingValueNode(runtime, key); node != nil {
		return node.Value
	}
	return ""
}

// The orchestrator's own rest, close and ask on its thread are marked with the
// publication's stamp; the same verbs from any other session are not.
func TestOrchestratorActsOnItsThreadAreMarked(t *testing.T) {
	t.Parallel()
	for _, actor := range []string{"chair-session", "thread-session", ""} {
		for _, verb := range []string{"rest", "close", "ask", "rest-routed"} {
			env := testEnv(t)
			env.Set("CLAUDE_CODE_SESSION_ID", "")
			args := []string{}
			switch verb {
			case "rest":
				env.Set("CLAUDE_CODE_SESSION_ID", actor)
				args = []string{"rest", "hub/t", "--local"}
			case "rest-routed":
				// The daemon writes on the caller's behalf, outside any harness.
				args = []string{"rest", "hub/t", "--local", "--actor", actor}
			case "close":
				env.Set("CLAUDE_CODE_SESSION_ID", actor)
				args = []string{"close", "hub/t"}
			case "ask":
				env.Set("CLAUDE_CODE_SESSION_ID", actor)
				args = []string{"ask", "hub/t", "which one?"}
			}
			dir, storage := newStore(t)
			seedOrchestrated(t, storage)
			if out, err := runIn(t, env, dir, args...); err != nil {
				t.Fatalf("%s by %q: %v\n%s", verb, actor, err, out)
			}
			got := orchestratorActed(t, storage, "hub/t")
			want := ""
			if actor == "chair-session" {
				f := mustRead(t, storage, "hub/t")
				switch verb {
				case "close":
					want = f.ClosedAt.Format(time.RFC3339Nano)
				case "ask":
					block, _, _ := shuttle.BlockOf(f)
					want = block.Ask.At
				default:
					want = runtimeValue(t, storage, "hub/t", "handed_off_at")
				}
				if want == "" {
					t.Fatalf("%s: no publication stamp", verb)
				}
			}
			if got != want {
				t.Errorf("%s by %q: %s = %q, want %q", verb, actor, orchestratorActedKey, got, want)
			}
		}
	}
}

// A rest routed to the daemon carries the caller's session, which the daemon's
// own write (outside any harness) cannot read from its environment.
func TestRoutedRestCarriesTheCallersSession(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "test-host")
	env.Set("CLAUDE_CODE_SESSION_ID", "chair-session")
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "hub/t", felt.StatusActive, map[string]any{"kind": "oneshot", "host": "test-host", "project_dir": dir}, nil)
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/lifecycle" {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		w.Write([]byte("rested hub/t\n"))
	}))
	t.Cleanup(server.Close)
	env.Set("SHUTTLE_DAEMON_URL", server.URL)
	if out, err := runIn(t, env, dir, "rest", "hub/t"); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if body["action"] != "rest" || body["actor"] != "chair-session" {
		t.Fatalf("routed body %v", body)
	}
}
