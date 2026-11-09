package shuttlecli

import (
	"fmt"
	"github.com/cailmdaley/felt/internal/felt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestThreadFromSubtreeViewSendsNamespacePath(t *testing.T) {
	t.Parallel()
	env := remoteLifecycleEnv(t)
	loom, st := newStore(t)
	seedShuttleRole(t, st, "science/team/hub", felt.StatusActive, map[string]any{"kind": "oneshot", "host": "hub", "project_dir": t.TempDir()}, nil)
	project := t.TempDir()
	if err := os.Symlink(filepath.Join(loom, ".felt", "science", "team"), filepath.Join(project, ".felt")); err != nil {
		t.Fatal(err)
	}
	var bodies requestBodies
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/fiber/create":
			bodies.record(t, r)
			fmt.Fprint(w, `{"id":"science/team/hub/measure","uid":"01JARZ3NDEKTSV4RRFFQ69G5FA","host":"worker","status":"active"}`)
		case "/api/v1/project-dir/resolve":
			fmt.Fprint(w, `{"path":"/remote/project"}`)
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
		}
	}))
	out, _, err := executeIn(t, env, project, "thread", "hub", "Measure", "--host", "worker", "--project-dir", "/remote/project")
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(out) != "science/team/hub/measure" {
		t.Fatalf("thread id = %q", out)
	}
	payload := bodies.last()
	frontmatter := payload["frontmatter"].(map[string]any)
	parent := frontmatter["shuttle"].(map[string]any)["thread_parent"].(map[string]any)
	if payload["id"] != "science/team/hub/measure" || parent["slug"] != "science/team/hub" || parent["uid"] != mustRead(t, st, "science/team/hub").UID {
		t.Fatalf("view-relative identity crossed hosts: %#v", payload)
	}
}

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
					_, _ = w.Write([]byte(`{"id":"parent/ask","uid":"01JARZ3NDEKTSV4RRFFQ69G5FA","host":"worker","status":"active"}`))
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
	ownerPath := filepath.Join(t.TempDir(), "owner.md")
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/document-changed":
			w.WriteHeader(http.StatusOK)
		case "/api/v1/project-dir/resolve":
			_, _ = w.Write([]byte(`{"path":"/remote/project"}`))
		case "/api/v1/lifecycle":
			workerFiberMissing(w)
		case "/api/v1/state/composite":
			fmt.Fprint(w, `{"remotes":{"worker":{"snapshot":{"boot_quarantine":true}}}}`)
		case "/api/v1/fiber/create":
			create.record(t, r)
			payload := create.last()
			_, _ = fmt.Fprintf(w, `{"id":%q,"uid":%q,"path":%q,"host":"worker","status":"active"}`, payload["id"], payload["uid"], ownerPath)
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
	if _, err := st.Read("parent/measure"); err == nil {
		t.Fatal("local draft remains after transfer")
	}
}

func TestRemoteThreadInvalidCreateIdentityIsReportedAsUncertain(t *testing.T) {
	t.Parallel()
	env := remoteLifecycleEnv(t)
	dir, st := newStore(t)
	seedShuttleRole(t, st, "parent", felt.StatusActive, map[string]any{"kind": "oneshot", "host": "hub", "project_dir": t.TempDir(), "agent": "claude-opus"}, nil)
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/project-dir/resolve":
			_, _ = w.Write([]byte(`{"path":"/remote/project"}`))
		case "/api/v1/fiber/create":
			_, _ = w.Write([]byte(`{"id":"parent/measure","uid":"not-a-ulid","host":"worker","status":"active"}`))
		default:
			t.Errorf("unexpected request %s", r.URL.String())
			http.NotFound(w, r)
		}
	}))
	_, _, err := executeIn(t, env, dir, "thread", "parent", "Measure", "--host", "worker", "--project-dir", "/remote/project")
	if err == nil || !strings.Contains(err.Error(), "fiber may already exist") {
		t.Fatalf("create response error = %v", err)
	}
	if _, err := st.Read("parent/measure"); err == nil {
		t.Fatal("uncertain remote create left a local copy")
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
			id := "parent/measure"
			if len(creates.all()) == 2 {
				id = "parent/measure/build-report"
			}
			_, _ = fmt.Fprintf(w, `{"id":%q,"uid":"01JARZ3NDEKTSV4RRFFQ69G5FA","host":"worker","status":"active"}`, id)
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/fibers/composite":
			_, _ = w.Write([]byte(`{"fibers":[{"path":"parent/measure/measure.md","origin":"worker","fiber":{"id":"01JARZ3NDEKTSV4RRFFQ69G5FA","slug":"parent/measure","name":"Measure","status":"open","shuttle":{"kind":"oneshot","host":"worker","agent":"claude-opus","project_dir":"/remote/project"}}}]}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/fibers/parent/measure":
			if r.URL.Query().Get("origin") != "worker" {
				t.Errorf("owner read query = %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"fibers":[{"fiber":{"id":"01JARZ3NDEKTSV4RRFFQ69G5FA","slug":"parent/measure","name":"Measure","status":"open","body":"Measure\n\n## Desired State\n\n## Status","shuttle":{"kind":"oneshot","host":"worker","agent":"claude-opus","project_dir":"/remote/project"}}}]}`))
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
	parentRef, _ := block["thread_parent"].(map[string]any)
	if parentRef["uid"] != mustRead(t, st, "parent").UID || parentRef["host"] != "hub" || parentRef["slug"] != "parent" {
		t.Fatalf("remote thread lost its parent identity: %#v", parentRef)
	}
	if create["id"] != "parent/measure" || create["origin"] != "worker" || block["host"] != "worker" {
		t.Fatalf("remote create payload = %#v", create)
	}
	if _, _, err := executeIn(t, env, dir, "resume", "parent/measure"); err != nil {
		t.Fatal(err)
	}
	if got := lifecycle.last(); got["fiber"] != "01JARZ3NDEKTSV4RRFFQ69G5FA" || got["origin"] != "worker" || got["action"] != "resume" {
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
			if got := bodies.last(); got["action"] != tc.verb || got["fiber"] != mustRead(t, st, "new/task").UID || got["origin"] != "worker" {
				t.Fatalf("payload %#v", got)
			}
			if mustRead(t, st, "new/task").Status != tc.status {
				t.Fatal("changed local mirror")
			}
		})
	}
}
