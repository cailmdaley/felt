package shuttlecli

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/cailmdaley/felt/internal/sysenv"
	"github.com/spf13/cobra"
)

func TestRemoteInstallAndRepeatTransferMissingSourceWithIdentityAndMetadata(t *testing.T) {
	t.Parallel()
	for _, verb := range []string{"install", "repeat"} {
		t.Run(verb, func(t *testing.T) {
			t.Parallel()
			env := remoteLifecycleEnv(t)
			dir, st := newStore(t)
			f, err := felt.New(verb+"-source", "Source")
			if err != nil {
				t.Fatal(err)
			}
			f.Body = "source body\n\n## Desired State\n"
			f.Description = "source description"
			due := time.Date(2026, 11, 30, 0, 0, 0, 0, time.UTC)
			f.Due = &due
			uid := f.UID
			if err := st.Write(f); err != nil {
				t.Fatal(err)
			}
			var create requestBodies
			serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/v1/project-dir/resolve":
					_, _ = w.Write([]byte(`{"path":"/remote/project"}`))
				case "/api/v1/lifecycle":
					http.Error(w, `{"error":"fiber not found on worker"}`, http.StatusNotFound)
				case "/api/v1/fiber/create":
					create.record(t, r)
					got := create.last()
					_, _ = fmt.Fprintf(w, `{"id":%q,"uid":%q}`, got["id"], got["uid"])
				default:
					t.Errorf("unexpected request %s", r.URL.String())
					http.NotFound(w, r)
				}
			}))
			args := []string{verb, f.ID, "--host", "worker", "--project-dir", "/remote/project"}
			if verb == "repeat" {
				args = append(args, "--schedule", "0 9 * * *")
			}
			if _, _, err := executeIn(t, env, dir, args...); err != nil {
				t.Fatal(err)
			}
			payload := create.last()
			frontmatter, _ := payload["frontmatter"].(map[string]any)
			stored, _ := st.Read(f.ID)
			if payload["id"] != f.ID || payload["uid"] != uid || payload["body"] != stored.Body || frontmatter["description"] != "source description" || frontmatter["due"] != "2026-11-30" {
				t.Fatalf("incomplete source transfer: %#v", payload)
			}
			if _, err := st.Read(f.ID); err != nil {
				t.Fatalf("lost local source after failed owner lookup: %v", err)
			}
		})
	}
}

func TestDirectOwnerCommandUsesShuttleAndOmitsLocalStore(t *testing.T) {
	t.Parallel()
	root := &cobra.Command{Use: "shuttle"}
	command := &cobra.Command{Use: "reopen"}
	root.AddCommand(command)
	command.Flags().String("store", "", "Felt store root")
	if err := command.Flags().Set("store", "/local/store"); err != nil {
		t.Fatal(err)
	}
	if got, want := directOwnerCommand(command, []string{"task"}), "shuttle reopen task"; got != want {
		t.Fatalf("direct owner command = %q, want %q", got, want)
	}
}

// remoteLifecycleEnv is an env on host "hub" whose fleet names one remote,
// "worker".
func remoteLifecycleEnv(t *testing.T) *sysenv.Env {
	t.Helper()
	env := testEnv(t)
	ownHost(t, env, "hub")
	writeRemotesIn(t, env, `{"version":1,"remotes":[{"name":"worker","port":4001}]}`)
	return env
}

// requestBodies records the JSON body of each request a fake daemon receives;
// handler goroutines write it while the test reads it.
type requestBodies struct {
	mu     sync.Mutex
	bodies []map[string]any
}

func (b *requestBodies) record(t testing.TB, r *http.Request) {
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		t.Errorf("decode request: %v", err)
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.bodies = append(b.bodies, body)
}

func (b *requestBodies) all() []map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]map[string]any(nil), b.bodies...)
}

// last is the most recent body, nil before any request.
func (b *requestBodies) last() map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.bodies) == 0 {
		return nil
	}
	return b.bodies[len(b.bodies)-1]
}

func remoteShuttleBlock(projectDir string) map[string]any {
	return map[string]any{
		"kind":        "oneshot",
		"host":        "worker",
		"agent":       "claude-opus",
		"project_dir": projectDir,
	}
}

func TestShuttleReopenRemoteDispatchesFreshWithMessage(t *testing.T) {
	t.Parallel()
	env := remoteLifecycleEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "work/task", felt.StatusClosed, remoteShuttleBlock(t.TempDir()), nil)

	var bodies requestBodies
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/dispatch" {
			t.Errorf("request = %s %s, want POST /api/v1/dispatch", r.Method, r.URL.Path)
		}
		bodies.record(t, r)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"dispatched":true}`))
	}))

	if _, _, err := executeIn(t, env, dir, "reopen", "work/task", "--message", "Start with the latest measurements"); err != nil {
		t.Fatalf("remote reopen: %v", err)
	}
	got := bodies.last()
	if got["fiber_id"] != "work/task" || got["origin"] != "worker" || got["force"] != true || got["ad_hoc"] != true || got["resume_mode"] != "fresh" || got["user_message"] != "Start with the latest measurements" {
		t.Fatalf("dispatch payload = %#v", got)
	}
	if f := mustRead(t, storage, "work/task"); f.Status != felt.StatusClosed {
		t.Fatalf("hub mirror status = %q, want unchanged closed", f.Status)
	}
}

func TestShuttleRemoteReopenDraftUsesLifecycleAndMessageFileFeedsDispatch(t *testing.T) {
	t.Parallel()
	env := remoteLifecycleEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "draft", felt.StatusClosed, remoteShuttleBlock(t.TempDir()), nil)
	messageFile := filepath.Join(t.TempDir(), "directive.txt")
	if err := os.WriteFile(messageFile, []byte("Read the handoff first.\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	var bodies requestBodies
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/dispatch" {
			t.Errorf("request path = %s, want dispatch", r.URL.Path)
		}
		bodies.record(t, r)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"dispatched":true}`))
	}))

	if _, _, err := executeIn(t, env, dir, "reopen", "draft", "--message-file", messageFile); err != nil {
		t.Fatalf("reopen with message file: %v", err)
	}
	got := bodies.last()
	if got["user_message"] != "Read the handoff first.\n" || got["resume_mode"] != "fresh" {
		t.Fatalf("dispatch payload = %#v", got)
	}
	if got["origin"] != "worker" || got["force"] != true || got["ad_hoc"] != true {
		t.Fatalf("dispatch did not route/force: %#v", got)
	}
	if mustRead(t, storage, "draft").Status != felt.StatusClosed {
		t.Fatal("remote reopen wrote the hub's Git mirror")
	}
}

func TestShuttleRemoteSetAgentRoutesProjectDir(t *testing.T) {
	t.Parallel()
	env := remoteLifecycleEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "fiber", felt.StatusClosed, map[string]any{
		"kind": "oneshot", "host": "worker", "agent": "claude-opus",
	}, nil)
	projectDir := t.TempDir()
	var bodies requestBodies
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/lifecycle" {
			t.Errorf("request path = %s, want lifecycle", r.URL.Path)
		}
		bodies.record(t, r)
		_, _ = w.Write([]byte("project_dir updated\n"))
	}))

	if _, _, err := executeIn(t, env, dir, "set-agent", "fiber", "--project-dir", projectDir); err != nil {
		t.Fatalf("remote set-agent project_dir: %v", err)
	}
	got := bodies.last()
	if got["action"] != "set-agent" || got["fiber"] != "fiber" || got["origin"] != "worker" || got["project_dir"] != projectDir {
		t.Fatalf("lifecycle payload = %#v", got)
	}
	if mustRead(t, storage, "fiber").Status != felt.StatusClosed {
		t.Fatal("remote config edit changed the hub mirror")
	}
}

func TestShuttleRemoteReopenSetsProjectDirBeforeFreshDispatch(t *testing.T) {
	t.Parallel()
	env := remoteLifecycleEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "closed", felt.StatusClosed, map[string]any{
		"kind": "oneshot", "host": "worker", "agent": "claude-opus",
	}, nil)
	projectDir := filepath.Join(t.TempDir(), "remote-only")
	var bodies requestBodies
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bodies.record(t, r)
		switch r.URL.Path {
		case "/api/v1/lifecycle":
			_, _ = w.Write([]byte("project_dir updated\n"))
		case "/api/v1/dispatch":
			_, _ = w.Write([]byte(`{"dispatched":true}`))
		default:
			t.Errorf("unexpected route %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))

	if _, _, err := executeIn(t, env, dir, "reopen", "closed", "--project-dir", projectDir); err != nil {
		t.Fatalf("remote reopen with project_dir: %v", err)
	}
	calls := bodies.all()
	if len(calls) != 2 {
		t.Fatalf("requests = %#v, want project-dir write followed by dispatch", calls)
	}
	if calls[0]["action"] != "set-agent" || calls[0]["fiber"] != "closed" || calls[0]["origin"] != "worker" || calls[0]["project_dir"] != projectDir {
		t.Fatalf("project_dir request = %#v", calls[0])
	}
	if calls[1]["fiber_id"] != "closed" || calls[1]["origin"] != "worker" || calls[1]["force"] != true || calls[1]["ad_hoc"] != true || calls[1]["resume_mode"] != "fresh" {
		t.Fatalf("dispatch request = %#v", calls[1])
	}
	if mustRead(t, storage, "closed").Status != felt.StatusClosed {
		t.Fatal("remote reopen wrote the hub's Git mirror")
	}
}

func TestShuttleRemoteDraftReopenUsesLifecycleAction(t *testing.T) {
	t.Parallel()
	env := remoteLifecycleEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "draft", felt.StatusClosed, remoteShuttleBlock(""), nil)

	var bodies requestBodies
	projectDir := t.TempDir()
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/lifecycle" {
			t.Errorf("request path = %s, want lifecycle", r.URL.Path)
		}
		bodies.record(t, r)
		_, _ = w.Write([]byte("reopened draft\n"))
	}))

	if _, _, err := executeIn(t, env, dir, "reopen", "draft", "--as-draft", "--project-dir", projectDir); err != nil {
		t.Fatalf("remote draft reopen: %v", err)
	}
	got := bodies.last()
	if got["action"] != "reopen" || got["fiber"] != "draft" || got["origin"] != "worker" || got["as_draft"] != true || got["project_dir"] != projectDir {
		t.Fatalf("lifecycle payload = %#v", got)
	}
	if mustRead(t, storage, "draft").Status != felt.StatusClosed {
		t.Fatal("remote draft reopen wrote the hub's Git mirror")
	}
}

func TestShuttleRemoteDispatchRoutesAndCarriesMessageFile(t *testing.T) {
	t.Parallel()
	env := remoteLifecycleEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "active", felt.StatusActive, remoteShuttleBlock(t.TempDir()), nil)
	messageFile := filepath.Join(t.TempDir(), "directive.txt")
	if err := os.WriteFile(messageFile, []byte("Run the focused check"), 0o600); err != nil {
		t.Fatal(err)
	}

	var bodies requestBodies
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/dispatch" {
			t.Errorf("request path = %s, want dispatch", r.URL.Path)
		}
		bodies.record(t, r)
		_, _ = w.Write([]byte(`{"dispatched":true}`))
	}))

	if _, _, err := executeIn(t, env, dir, "dispatch", "active", "--ad-hoc", "--message-file", messageFile); err != nil {
		t.Fatalf("remote dispatch: %v", err)
	}
	got := bodies.last()
	if got["fiber_id"] != "active" || got["origin"] != "worker" || got["ad_hoc"] != true || got["user_message"] != "Run the focused check" {
		t.Fatalf("dispatch payload = %#v", got)
	}
	if mustRead(t, storage, "active").Status != felt.StatusActive {
		t.Fatal("dispatch changed the hub mirror")
	}
}

func TestRemoteLifecycleVerbsUseBoardOwnerRoute(t *testing.T) {
	t.Parallel()
	project := t.TempDir()
	for _, tc := range []struct {
		id     string
		status string
		block  map[string]any
		args   []string
		action string
		check  func(*testing.T, map[string]any)
	}{
		{"pause", felt.StatusActive, remoteShuttleBlock(project), []string{"pause", "pause", "--no-kill"}, "pause", func(t *testing.T, body map[string]any) {
			if body["no_kill"] != true {
				t.Fatalf("pause payload = %#v", body)
			}
		}},
		{"resume", felt.StatusOpen, remoteShuttleBlock(project), []string{"resume", "resume"}, "resume", nil},
		{"close", felt.StatusActive, remoteShuttleBlock(project), []string{"close", "close", "--tempered=false"}, "close", func(t *testing.T, body map[string]any) {
			if body["tempered"] != false {
				t.Fatalf("close payload = %#v", body)
			}
		}},
		{"quiet", felt.StatusActive, remoteShuttleBlock(project), []string{"close", "quiet", "--quiet"}, "close", func(t *testing.T, body map[string]any) {
			if body["quiet"] != true {
				t.Fatalf("quiet close payload = %#v", body)
			}
		}},
		{"accept", felt.StatusClosed, map[string]any{"kind": "standing", "host": "worker", "agent": "claude-opus", "project_dir": project, "schedule": map[string]any{"expr": "0 9 * * *", "tz": "UTC"}}, []string{"accept", "accept"}, "accept", nil},
		{"rest", felt.StatusActive, remoteShuttleBlock(project), []string{"rest", "rest"}, "rest", nil},
		{"outcome", felt.StatusActive, remoteShuttleBlock(project), []string{"set-outcome", "outcome", "--outcome", "new outcome"}, "set-outcome", func(t *testing.T, body map[string]any) {
			if body["outcome"] != "new outcome" {
				t.Fatalf("set-outcome payload = %#v", body)
			}
		}},
		{"model", felt.StatusActive, remoteShuttleBlock(project), []string{"set-model", "model", "claude-sonnet"}, "set-model", func(t *testing.T, body map[string]any) {
			if body["agent"] != "claude-sonnet" {
				t.Fatalf("set-model payload = %#v", body)
			}
		}},
		{"agent", felt.StatusActive, remoteShuttleBlock(project), []string{"set-agent", "agent", "claude-sonnet", "--effort", "high", "--chrome=true"}, "set-agent", func(t *testing.T, body map[string]any) {
			if body["agent"] != "claude-sonnet" || body["effort"] != "high" || body["chrome"] != true {
				t.Fatalf("set-agent payload = %#v", body)
			}
		}},
		{"reshape", felt.StatusActive, remoteShuttleBlock(project), []string{"reshape", "reshape", "standing", "--schedule", "0 8 * * *", "--tz", "UTC"}, "reshape", func(t *testing.T, body map[string]any) {
			if body["kind"] != "standing" || body["schedule"] != "0 8 * * *" || body["tz"] != "UTC" {
				t.Fatalf("reshape payload = %#v", body)
			}
		}},
		{"role", felt.StatusOpen, remoteShuttleBlock(project), []string{"role", "role", "cmbx-chair"}, "role", func(t *testing.T, body map[string]any) {
			if body["role"] != "cmbx-chair" || body["clear"] != nil {
				t.Fatalf("role payload = %#v", body)
			}
		}},
		{"newrole", felt.StatusOpen, remoteShuttleBlock(project), []string{"role", "newrole", "editor", "--new", "Office editor"}, "role", func(t *testing.T, body map[string]any) {
			if body["role"] != "editor" || body["new_name"] != "Office editor" {
				t.Fatalf("role --new payload = %#v", body)
			}
		}},
		{"unrole", felt.StatusOpen, remoteShuttleBlock(project), []string{"role", "unrole", "--clear"}, "role", func(t *testing.T, body map[string]any) {
			if body["clear"] != true || body["role"] != nil {
				t.Fatalf("role --clear payload = %#v", body)
			}
		}},
		{"seat", felt.StatusOpen, remoteShuttleBlock(project), []string{"seat", "seat"}, "seat", func(t *testing.T, body map[string]any) {
			if body["role"] != nil || body["clear"] != nil {
				t.Fatalf("seat payload = %#v", body)
			}
		}},
		{"unseat", felt.StatusOpen, remoteShuttleBlock(project), []string{"seat", "unseat", "--clear"}, "seat", func(t *testing.T, body map[string]any) {
			if body["clear"] != true || body["role"] != nil {
				t.Fatalf("seat --clear payload = %#v", body)
			}
		}},
		{"uninstall", felt.StatusActive, remoteShuttleBlock(project), []string{"uninstall", "uninstall"}, "uninstall", nil},
	} {
		t.Run(tc.id, func(t *testing.T) {
			t.Parallel()
			env := remoteLifecycleEnv(t)
			dir, storage := newStore(t)
			seedShuttleRole(t, storage, tc.id, tc.status, tc.block, nil)
			var bodies requestBodies
			serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v1/state/composite" {
					_, _ = w.Write([]byte(`{"remotes":{}}`))
					return
				}
				if r.URL.Path != "/api/v1/lifecycle" {
					t.Errorf("request path = %s, want lifecycle", r.URL.Path)
				}
				bodies.record(t, r)
				_, _ = w.Write([]byte("forwarded\n"))
			}))
			if _, _, err := executeIn(t, env, dir, tc.args...); err != nil {
				t.Fatalf("%s: %v", tc.id, err)
			}
			got := bodies.last()
			if got["action"] != tc.action || got["fiber"] != tc.id || got["origin"] != "worker" {
				t.Fatalf("lifecycle payload = %#v", got)
			}
			if tc.check != nil {
				tc.check(t, got)
			}
			fiber := mustRead(t, storage, tc.id)
			if fiber.Status != tc.status {
				t.Fatalf("remote lifecycle verb mutated status in the mirror for %s", tc.id)
			}
			if !shuttle.HasFacet(fiber) {
				t.Fatalf("remote lifecycle verb removed the shuttle block from the mirror for %s", tc.id)
			}
		})
	}
}

func TestRemoteLifecycleUnknownOwnerAndLocalDaemonDownRefuseWithCommand(t *testing.T) {
	t.Parallel()
	t.Run("unknown remote", func(t *testing.T) {
		t.Parallel()
		env := testEnv(t)
		ownHost(t, env, "hub")
		missing := filepath.Join(t.TempDir(), "remotes.json")
		env.Set("SHUTTLE_REMOTES_FILE", missing)
		dir, storage := newStore(t)
		seedShuttleRole(t, storage, "task", felt.StatusClosed, remoteShuttleBlock(t.TempDir()), nil)
		_, _, err := executeIn(t, env, dir, "reopen", "task")
		if err == nil || !strings.Contains(err.Error(), "nor a discovered tailnet peer") || !strings.Contains(err.Error(), "shuttle reopen task") || !strings.Contains(err.Error(), missing) {
			t.Fatalf("unknown-owner refusal = %v", err)
		}
		if mustRead(t, storage, "task").Status != felt.StatusClosed {
			t.Fatal("unknown-owner refusal mutated the mirror")
		}
	})

	t.Run("local daemon down", func(t *testing.T) {
		t.Parallel()
		env := remoteLifecycleEnv(t)
		dir, storage := newStore(t)
		seedShuttleRole(t, storage, "task", felt.StatusClosed, remoteShuttleBlock(t.TempDir()), nil)
		serveDaemon(t, env, http.NotFoundHandler()).Close()
		_, _, err := executeIn(t, env, dir, "reopen", "task")
		if err == nil || !strings.Contains(err.Error(), "local shuttle daemon is unreachable") || !strings.Contains(err.Error(), "did not receive the request") || !strings.Contains(err.Error(), "shuttle reopen task") {
			t.Fatalf("daemon-down refusal = %v", err)
		}
		if mustRead(t, storage, "task").Status != felt.StatusClosed {
			t.Fatal("daemon-down refusal mutated the mirror")
		}
	})
}

func TestRemoteForwardFailuresSayOwnerUnreachableAndActionMayHaveApplied(t *testing.T) {
	t.Parallel()
	for _, body := range []string{
		"forward to worker failed: :socket_closed_remotely",
		"forward to worker failed: stale origin",
	} {
		t.Run(body, func(t *testing.T) {
			t.Parallel()
			env := remoteLifecycleEnv(t)
			dir, storage := newStore(t)
			seedShuttleRole(t, storage, "task", felt.StatusActive, remoteShuttleBlock(t.TempDir()), nil)
			serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				http.Error(w, body, http.StatusBadGateway)
			}))
			_, _, err := executeIn(t, env, dir, "close", "task")
			if err == nil || !strings.Contains(err.Error(), `owning host "worker" is unreachable`) || !strings.Contains(err.Error(), "action may have been applied") || !strings.Contains(err.Error(), "shuttle close task") {
				t.Fatalf("forward failure = %v", err)
			}
			if mustRead(t, storage, "task").Status != felt.StatusActive {
				t.Fatal("forward failure mutated the mirror")
			}
		})
	}
}

func TestRemoteDispatchForwardFailureMapsAmbiguousOwnerOutcome(t *testing.T) {
	t.Parallel()
	env := remoteLifecycleEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "active", felt.StatusActive, remoteShuttleBlock(t.TempDir()), nil)
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"dispatched":false,"reason":"forward_failed","origin":"worker","error":"socket_closed_remotely"}`))
	}))

	_, _, err := executeIn(t, env, dir, "dispatch", "active")
	if err == nil || !strings.Contains(err.Error(), `owning host "worker" is unreachable`) || !strings.Contains(err.Error(), "action may have been applied") {
		t.Fatalf("dispatch forward failure = %v", err)
	}
	if mustRead(t, storage, "active").Status != felt.StatusActive {
		t.Fatal("dispatch forward failure mutated the hub mirror")
	}
}

func TestRemoteResumeReportsFreshRemoteBootQuarantine(t *testing.T) {
	t.Parallel()
	env := remoteLifecycleEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "draft", felt.StatusOpen, remoteShuttleBlock(t.TempDir()), nil)
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/lifecycle":
			_, _ = w.Write([]byte("resumed draft\n"))
		case "/api/v1/state/composite":
			_, _ = w.Write([]byte(`{"remotes":{"worker":{"stale":false,"snapshot":{"boot_quarantine":true}}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	out, _, err := executeIn(t, env, dir, "resume", "draft")
	if err != nil {
		t.Fatalf("remote resume: %v", err)
	}
	if !strings.Contains(out, "may stay pending") || !strings.Contains(out, "shuttle daemon release") || mustRead(t, storage, "draft").Status != felt.StatusOpen {
		t.Fatalf("resume output = %q; hub mirror status = %q", out, mustRead(t, storage, "draft").Status)
	}
}

// The daemon shells every routing verb with --local. Such a call on a
// remote-owned fiber is refused as a mirror write and never routed back through
// the daemon.
func TestShuttleRemoteLifecycleLocalRefusesWithoutRouting(t *testing.T) {
	t.Parallel()
	env := remoteLifecycleEnv(t)
	dir, storage := newStore(t)
	block := remoteShuttleBlock(t.TempDir())
	block["kind"] = "standing"
	block["schedule"] = map[string]any{"expr": "0 9 * * *", "tz": "UTC"}
	seedShuttleRole(t, storage, "work/task", felt.StatusActive, block, nil)
	before, _ := os.ReadFile(storage.Path("work/task"))

	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("--local verb reached the daemon: %s %s", r.Method, r.URL.Path)
	}))

	for _, verb := range [][]string{
		{"pause"}, {"rest"}, {"resume"}, {"close"}, {"reopen"}, {"accept"}, {"set-outcome", "--outcome", "x"},
		{"set-model", "claude-opus"}, {"set-agent", "claude-opus"}, {"role", "--clear"}, {"seat", "--clear"}, {"reshape", "oneshot"}, {"uninstall"},
	} {
		argv := append([]string{verb[0], "work/task"}, verb[1:]...)
		argv = append(argv, "--local")
		_, _, err := executeIn(t, env, dir, argv...)
		var mismatch ownerMismatchError
		if !errors.As(err, &mismatch) {
			t.Fatalf("%s --local on a remote-owned fiber: want ownerMismatchError, got %T: %v", verb[0], err, err)
		}
	}
	after, _ := os.ReadFile(storage.Path("work/task"))
	if string(before) != string(after) {
		t.Fatal("refused --local verb modified the hub mirror")
	}
}

// TestShuttleRemoteDispatchReadsMessageFileFromItsWorkingDirectory runs two
// dispatches side by side with the same relative --message-file in different
// working directories, beside a decoy of that name in the test process's own.
func TestShuttleRemoteDispatchReadsMessageFileFromItsWorkingDirectory(t *testing.T) {
	t.Parallel()
	const name = "relative-launch-directive.txt"
	if err := os.WriteFile(name, []byte("decoy from the process working directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(name) })

	for _, directive := range []string{"directive one", "directive two"} {
		t.Run(directive, func(t *testing.T) {
			t.Parallel()
			env := remoteLifecycleEnv(t)
			dir, storage := newStore(t)
			seedShuttleRole(t, storage, "active", felt.StatusActive, remoteShuttleBlock(t.TempDir()), nil)
			cwd := t.TempDir()
			if err := os.WriteFile(filepath.Join(cwd, name), []byte(directive), 0o600); err != nil {
				t.Fatal(err)
			}
			env.Chdir(cwd)

			var bodies requestBodies
			serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				bodies.record(t, r)
				_, _ = w.Write([]byte(`{"dispatched":true}`))
			}))
			if _, _, err := executeIn(t, env, dir, "dispatch", "active", "--ad-hoc", "--message-file", name); err != nil {
				t.Fatalf("dispatch: %v", err)
			}
			if got := bodies.last()["user_message"]; got != directive {
				t.Fatalf("daemon received user_message %q, want %q", got, directive)
			}
		})
	}
}
