package shuttlecli

import (
	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
	"net/http"
	"strings"
	"testing"
)

func TestThreadRemoteDirectoryValidation(t *testing.T) {
	t.Parallel()
	for _, refusal := range []bool{false, true} {
		t.Run(map[bool]string{false: "valid", true: "invalid"}[refusal], func(t *testing.T) {
			t.Parallel()
			env := remoteLifecycleEnv(t)
			dir, st := newStore(t)
			seedShuttleRole(t, st, "parent", felt.StatusActive, map[string]any{"kind": "oneshot", "host": "hub", "project_dir": t.TempDir(), "agent": "claude-opus"}, nil)
			var bodies requestBodies
			serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/v1/project-dir/resolve" {
					t.Errorf("unexpected path %s", r.URL.Path)
				}
				bodies.record(t, r)
				if refusal {
					w.WriteHeader(422)
					_, _ = w.Write([]byte("not a directory on owner"))
					return
				}
				_, _ = w.Write([]byte(`{"path":"/remote/work/project"}`))
			}))
			_, _, err := executeIn(t, env, dir, "thread", "parent", "Ask", "--host", "worker", "--project-dir", "$WORK/project")
			if refusal {
				if err == nil {
					t.Fatal("created thread with invalid owner directory")
				}
				if _, err := st.Read("parent/ask"); err == nil {
					t.Fatal("wrote child before validation")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got := bodies.last(); got["origin"] != "worker" || got["path"] != "$WORK/project" {
				t.Fatalf("payload %#v", got)
			}
			b, _, _ := shuttle.BlockOf(mustRead(t, st, "parent/ask"))
			if b.ProjectDir != "/remote/work/project" || b.Host != "worker" {
				t.Fatalf("block %+v", b)
			}
		})
	}
}

func TestThreadRemoteDirectoryOffline(t *testing.T) {
	t.Parallel()
	env := remoteLifecycleEnv(t)
	dir, st := newStore(t)
	seedShuttleRole(t, st, "parent", felt.StatusActive, remoteShuttleBlock("/remote/work"), nil)
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(502) }))
	_, stderr, err := executeIn(t, env, dir, "thread", "parent", "Ask", "--project-dir", "/remote/not-local")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stderr, "not validated") || !strings.Contains(stderr, "worker") {
		t.Fatalf("warning %q", stderr)
	}
	b, _, _ := shuttle.BlockOf(mustRead(t, st, "parent/ask"))
	if b.ProjectDir != "/remote/not-local" {
		t.Fatalf("project dir %q", b.ProjectDir)
	}
}

func TestRemoteEarlyLifecycleNeverUsesLocalSnapshot(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct{ verb, status, kind string }{
		{"resume", felt.StatusOpen, "oneshot"},
		{"resume", felt.StatusClosed, "standing"},
		{"accept", felt.StatusClosed, "standing"},
		{"rest", felt.StatusActive, "oneshot"},
	} {
		t.Run(tc.verb+tc.status+tc.kind, func(t *testing.T) {
			t.Parallel()
			env := remoteLifecycleEnv(t)
			dir, st := newStore(t)
			block := remoteShuttleBlock("/remote/work")
			block["kind"] = tc.kind
			if tc.kind == "standing" {
				block["schedule"] = map[string]any{"cron": "0 9 * * *", "tz": "UTC"}
			}
			seedShuttleRole(t, st, "new/task", tc.status, block, nil)
			var bodies requestBodies
			serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "GET" {
					_, _ = w.Write([]byte(`{}`))
					return
				}
				bodies.record(t, r)
				if bodies.last()["origin"] != "worker" {
					w.WriteHeader(400)
					_, _ = w.Write([]byte("fiber not found in local snapshot"))
					return
				}
				_, _ = w.Write([]byte("owner applied\n"))
			}))
			if _, _, err := executeIn(t, env, dir, tc.verb, "new/task"); err != nil {
				t.Fatal(err)
			}
			if got := bodies.last(); got["action"] != tc.verb || got["fiber"] != "new/task" || got["origin"] != "worker" {
				t.Fatalf("payload %#v", got)
			}
			if mustRead(t, st, "new/task").Status != tc.status {
				t.Fatal("changed local mirror")
			}
		})
	}
}
