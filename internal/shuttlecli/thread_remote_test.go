package shuttlecli

import (
	"fmt"
	"github.com/cailmdaley/felt/internal/felt"
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
				if r.URL.Path == "/api/v1/fiber/create" {
					_, _ = w.Write([]byte(`{"id":"parent/ask","uid":"01JREMOTEUID0000000000000000"}`))
					return
				}
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
			if _, err := st.Read("parent/ask"); err == nil {
				t.Fatal("remote thread left a local copy")
			}
		})
	}
}

func TestResumingRemoteThreadDraftTransfersItToOwner(t *testing.T) {
	t.Parallel()
	env := remoteLifecycleEnv(t)
	dir, st := newStore(t)
	seedShuttleRole(t, st, "parent", felt.StatusActive, map[string]any{"kind": "oneshot", "host": "hub", "project_dir": t.TempDir(), "agent": "claude-opus"}, nil)
	var create requestBodies
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/project-dir/resolve":
			_, _ = w.Write([]byte(`{"path":"/remote/project"}`))
		case "/api/v1/lifecycle":
			http.Error(w, `{"error":"fiber not found on worker"}`, http.StatusNotFound)
		case "/api/v1/fiber/create":
			create.record(t, r)
			payload := create.last()
			_, _ = fmt.Fprintf(w, `{"id":%q,"uid":%q}`, payload["id"], payload["uid"])
		default:
			t.Errorf("unexpected request %s", r.URL.String())
			http.NotFound(w, r)
		}
	}))
	if _, _, err := executeIn(t, env, dir, "thread", "parent", "Measure", "--host", "worker", "--project-dir", "/remote/project", "--disabled"); err != nil {
		t.Fatal(err)
	}
	draft := mustRead(t, st, "parent/measure")
	if draft.Status != felt.StatusOpen {
		t.Fatalf("draft status = %s", draft.Status)
	}
	if _, _, err := executeIn(t, env, dir, "resume", "parent/measure"); err != nil {
		t.Fatal(err)
	}
	if got := create.last(); got["origin"] != "worker" || got["id"] != "parent/measure" {
		t.Fatalf("owner create payload = %#v", got)
	}
	if got := mustRead(t, st, "parent/measure"); got.Status != felt.StatusOpen {
		t.Fatalf("local draft was armed as a mirror: %s", got.Status)
	}
}

func TestRemoteThreadCreatesOnOwnerAndCanBeControlledWithoutMirror(t *testing.T) {
	t.Parallel()
	env := remoteLifecycleEnv(t)
	dir, st := newStore(t)
	seedShuttleRole(t, st, "parent", felt.StatusActive, map[string]any{"kind": "oneshot", "host": "hub", "project_dir": t.TempDir(), "agent": "claude-opus"}, nil)
	var creates, lifecycle requestBodies
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/project-dir/resolve":
			_, _ = w.Write([]byte(`{"path":"/remote/project"}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/fiber/create":
			creates.record(t, r)
			created := creates.last()
			_, _ = fmt.Fprintf(w, `{"id":%q,"uid":"01JREMOTEUID0000000000000000"}`, created["id"])
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/fibers/composite":
			_, _ = w.Write([]byte(`{"fibers":[{"path":"parent/measure/measure.md","origin":"worker","fiber":{"id":"01JREMOTEUID0000000000000000","slug":"parent/measure","name":"Measure","status":"open","shuttle":{"kind":"oneshot","host":"worker","agent":"claude-opus","project_dir":"/remote/project"}}}]}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/fibers/parent/measure":
			if r.URL.Query().Get("origin") != "worker" {
				t.Errorf("owner read query = %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"fibers":[{"fiber":{"id":"01JREMOTEUID0000000000000000","slug":"parent/measure","name":"Measure","status":"open","body":"Measure\n\n## Desired State\n\n## Status","shuttle":{"kind":"oneshot","host":"worker","agent":"claude-opus","project_dir":"/remote/project"}}}]}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/lifecycle":
			lifecycle.record(t, r)
			_, _ = w.Write([]byte("owner resumed\n"))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/state/composite":
			_, _ = w.Write([]byte(`{"remotes":{}}`))
		default:
			t.Errorf("unexpected daemon request %s %s", r.Method, r.URL.String())
			http.NotFound(w, r)
		}
	}))
	if _, _, err := executeIn(t, env, dir, "thread", "parent", "Measure", "--host", "worker", "--project-dir", "/remote/project"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Read("parent/measure"); err == nil {
		t.Fatal("remote thread left a local copy")
	}
	create := creates.last()
	frontmatter, _ := create["frontmatter"].(map[string]any)
	block, _ := frontmatter["shuttle"].(map[string]any)
	if create["id"] != "parent/measure" || create["origin"] != "worker" || block["host"] != "worker" {
		t.Fatalf("remote create payload = %#v", create)
	}
	if _, _, err := executeIn(t, env, dir, "resume", "parent/measure"); err != nil {
		t.Fatal(err)
	}
	if got := lifecycle.last(); got["fiber"] != "parent/measure" || got["origin"] != "worker" || got["action"] != "resume" {
		t.Fatalf("owner lifecycle payload = %#v", got)
	}
	if _, _, err := executeIn(t, env, dir, "resume", "parent/measure", "--local"); err == nil {
		t.Fatal("--local accepted a remote-only fiber")
	}
	if _, err := st.Read("parent/measure"); err == nil {
		t.Fatal("remote control created a local copy")
	}
	if _, _, err := executeIn(t, env, dir, "thread", "parent/measure", "Build report", "--host", "worker", "--project-dir", "/remote/project"); err != nil {
		t.Fatalf("thread from remote-only parent: %v", err)
	}
	if _, err := st.Read("parent/measure/build-report"); err == nil {
		t.Fatal("thread from remote-only parent left a local copy")
	}
	allCreates := creates.all()
	if len(allCreates) != 2 || allCreates[1]["id"] != "parent/measure/build-report" {
		t.Fatalf("remote child creates = %#v", allCreates)
	}
}

func TestThreadRemoteDirectoryOffline(t *testing.T) {
	t.Parallel()
	env := remoteLifecycleEnv(t)
	dir, st := newStore(t)
	seedShuttleRole(t, st, "parent", felt.StatusActive, remoteShuttleBlock("/remote/work"), nil)
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(502) }))
	_, stderr, err := executeIn(t, env, dir, "thread", "parent", "Ask", "--project-dir", "/remote/not-local")
	if err == nil {
		t.Fatal("expected unavailable owner to fail remote thread creation")
	}
	if !strings.Contains(stderr, "not validated") || !strings.Contains(stderr, "worker") {
		t.Fatalf("warning %q", stderr)
	}
	if _, err := st.Read("parent/ask"); err == nil {
		t.Fatal("unavailable remote thread left a local copy")
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
