package shuttlecli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestThreadTakeCreatesDisabledBeforeMigrating(t *testing.T) {
	t.Parallel()
	for _, name := range []string{"success", "failure", "rollback_failed"} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			dir, st := newStore(t)
			env.Set("SHUTTLE_HOST", "testhost")
			seedShuttleRole(t, st, "hub", "active", map[string]any{"kind": "oneshot", "host": "testhost", "agent": "claude-opus", "project_dir": dir}, nil)
			env.Set("SHUTTLE_FIBER_PATH", st.Path("hub"))
			var calls int
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.URL.Path != "/api/v1/migrate" {
					t.Errorf("unexpected route %s", r.URL.Path)
				}
				child := mustRead(t, st, "hub/sidequest")
				if child.Status != felt.StatusOpen {
					t.Errorf("child armed before migration: %s", child.Status)
				}
				// Acquiring the document locks must work before the request is sent.
				unlock, err := st.LockFiber("hub/sidequest")
				if err != nil {
					t.Error(err)
				} else {
					unlock()
				}
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if body["from"] != "hub" || body["to"] != "hub/sidequest" {
					t.Errorf("payload %+v", body)
				}
				if name != "success" {
					w.WriteHeader(422)
					if name == "rollback_failed" {
						w.Write([]byte(`{"ok":false,"reason":"rollback_failed"}`))
					} else {
						w.Write([]byte(`{"ok":false,"reason":"not_running"}`))
					}
					return
				}
				w.Write([]byte(`{"ok":true,"from":"hub","to":"hub/sidequest","session_uuid":"moved"}`))
			}))
			defer server.Close()
			env.Set("SHUTTLE_DAEMON_URL", server.URL)
			out, err := runIn(t, env, dir, "thread", "hub", "Sidequest", "--take", "--json")
			if calls != 1 {
				t.Fatalf("migration calls=%d; %v", calls, err)
			}
			if name == "rollback_failed" {
				if err == nil || !strings.Contains(err.Error(), "assignment is unconfirmed") || strings.Contains(err.Error(), "remains disabled") {
					t.Fatalf("rollback uncertainty misreported: %v", err)
				}
			} else if name == "failure" {
				if err == nil || !strings.Contains(err.Error(), "hub/sidequest was created but remains disabled") {
					t.Fatalf("%v", err)
				}
				if mustRead(t, st, "hub/sidequest").Status != felt.StatusOpen {
					t.Fatal("failure left child armed")
				}
			} else if err != nil || !strings.Contains(out, `"id": "hub/sidequest"`) {
				t.Fatalf("%v: %s", err, out)
			}
		})
	}
}

func TestThreadTakeRejectsIncompatibleFlagsBeforeCreation(t *testing.T) {
	t.Parallel()
	for _, flags := range [][]string{{"--disabled"}, {"--host", "other"}} {
		t.Run(strings.Join(flags, " "), func(t *testing.T) {
			env := testEnv(t)
			dir, st := newStore(t)
			env.Set("SHUTTLE_HOST", "testhost")
			seedShuttleRole(t, st, "hub", "active", map[string]any{"kind": "oneshot", "host": "testhost", "agent": "claude-opus", "project_dir": dir}, nil)
			env.Set("SHUTTLE_FIBER_PATH", st.Path("hub"))
			args := append([]string{"thread", "hub", "Sidequest", "--take", "--project-dir", dir}, flags...)
			if _, err := runIn(t, env, dir, args...); err == nil {
				t.Fatal("accepted incompatible flags")
			}
			fibers, err := st.ListMetadata()
			if err != nil || len(fibers) != 1 {
				t.Fatalf("partial child: %v %v", fibers, err)
			}
		})
	}
}
