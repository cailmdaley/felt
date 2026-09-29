package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func configureRemoteLifecycleTest(t *testing.T) {
	t.Helper()
	withOwnHost(t, "hub")
	writeRemotes(t, `{"version":1,"remotes":[{"name":"worker","port":4001}]}`)
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
	configureRemoteLifecycleTest(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "work/task", felt.StatusClosed, remoteShuttleBlock(t.TempDir()), nil)

	var got map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/dispatch" {
			t.Errorf("request = %s %s, want POST /api/v1/dispatch", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"dispatched":true}`))
	}))
	defer server.Close()
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)

	if _, err := runCommand(t, dir, "shuttle", "reopen", "work/task", "--message", "Start with the latest measurements"); err != nil {
		t.Fatalf("remote reopen: %v", err)
	}
	if got["fiber_id"] != "work/task" || got["origin"] != "worker" || got["force"] != true || got["ad_hoc"] != true || got["resume_mode"] != "fresh" || got["user_message"] != "Start with the latest measurements" {
		t.Fatalf("dispatch payload = %#v", got)
	}
	if f := mustRead(t, storage, "work/task"); f.Status != felt.StatusClosed {
		t.Fatalf("hub mirror status = %q, want unchanged closed", f.Status)
	}
}

func TestShuttleRemoteReopenDraftUsesLifecycleAndMessageFileFeedsDispatch(t *testing.T) {
	configureRemoteLifecycleTest(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "draft", felt.StatusClosed, remoteShuttleBlock(t.TempDir()), nil)
	messageFile := filepath.Join(t.TempDir(), "directive.txt")
	if err := os.WriteFile(messageFile, []byte("Read the handoff first.\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	var got map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/dispatch" {
			t.Errorf("request path = %s, want dispatch", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode request: %v", err)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"dispatched":true}`))
	}))
	defer server.Close()
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)

	if _, err := runCommand(t, dir, "shuttle", "reopen", "draft", "--message-file", messageFile); err != nil {
		t.Fatalf("reopen with message file: %v", err)
	}
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
	configureRemoteLifecycleTest(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "fiber", felt.StatusClosed, map[string]any{
		"kind": "oneshot", "host": "worker", "agent": "claude-opus",
	}, nil)
	projectDir := t.TempDir()
	var got map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/lifecycle" {
			t.Errorf("request path = %s, want lifecycle", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode request: %v", err)
		}
		_, _ = w.Write([]byte("project_dir updated\n"))
	}))
	defer server.Close()
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)

	if _, err := runCommand(t, dir, "shuttle", "set-agent", "fiber", "--project-dir", projectDir); err != nil {
		t.Fatalf("remote set-agent project_dir: %v", err)
	}
	if got["action"] != "set-agent" || got["fiber"] != "fiber" || got["origin"] != "worker" || got["project_dir"] != projectDir {
		t.Fatalf("lifecycle payload = %#v", got)
	}
	if mustRead(t, storage, "fiber").Status != felt.StatusClosed {
		t.Fatal("remote config edit changed the hub mirror")
	}
}

func TestShuttleRemoteReopenSetsProjectDirBeforeFreshDispatch(t *testing.T) {
	configureRemoteLifecycleTest(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "closed", felt.StatusClosed, map[string]any{
		"kind": "oneshot", "host": "worker", "agent": "claude-opus",
	}, nil)
	projectDir := filepath.Join(t.TempDir(), "remote-only")
	var calls []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request: %v", err)
		}
		calls = append(calls, body)
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
	defer server.Close()
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)

	if _, err := runCommand(t, dir, "shuttle", "reopen", "closed", "--project-dir", projectDir); err != nil {
		t.Fatalf("remote reopen with project_dir: %v", err)
	}
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
	configureRemoteLifecycleTest(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "draft", felt.StatusClosed, remoteShuttleBlock(""), nil)

	var got map[string]any
	projectDir := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/lifecycle" {
			t.Errorf("request path = %s, want lifecycle", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode request: %v", err)
		}
		_, _ = w.Write([]byte("reopened draft\n"))
	}))
	defer server.Close()
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)

	if _, err := runCommand(t, dir, "shuttle", "reopen", "draft", "--as-draft", "--project-dir", projectDir); err != nil {
		t.Fatalf("remote draft reopen: %v", err)
	}
	if got["action"] != "reopen" || got["fiber"] != "draft" || got["origin"] != "worker" || got["as_draft"] != true || got["project_dir"] != projectDir {
		t.Fatalf("lifecycle payload = %#v", got)
	}
	if mustRead(t, storage, "draft").Status != felt.StatusClosed {
		t.Fatal("remote draft reopen wrote the hub's Git mirror")
	}
}

func TestShuttleRemoteDispatchRoutesAndCarriesMessageFile(t *testing.T) {
	configureRemoteLifecycleTest(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "active", felt.StatusActive, remoteShuttleBlock(t.TempDir()), nil)
	messageFile := filepath.Join(t.TempDir(), "directive.txt")
	if err := os.WriteFile(messageFile, []byte("Run the focused check"), 0o600); err != nil {
		t.Fatal(err)
	}

	var got map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/dispatch" {
			t.Errorf("request path = %s, want dispatch", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode request: %v", err)
		}
		_, _ = w.Write([]byte(`{"dispatched":true}`))
	}))
	defer server.Close()
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)

	if _, err := runCommand(t, dir, "shuttle", "dispatch", "active", "--ad-hoc", "--message-file", messageFile); err != nil {
		t.Fatalf("remote dispatch: %v", err)
	}
	if got["fiber_id"] != "active" || got["origin"] != "worker" || got["ad_hoc"] != true || got["user_message"] != "Run the focused check" {
		t.Fatalf("dispatch payload = %#v", got)
	}
	if mustRead(t, storage, "active").Status != felt.StatusActive {
		t.Fatal("dispatch changed the hub mirror")
	}
}

func TestRemoteLifecycleVerbsUseBoardOwnerRoute(t *testing.T) {
	configureRemoteLifecycleTest(t)
	dir, storage := newStore(t)
	project := t.TempDir()
	for _, tc := range []struct {
		id     string
		status string
		block  map[string]any
		args   []string
		action string
		check  func(*testing.T, map[string]any)
	}{
		{"pause", felt.StatusActive, remoteShuttleBlock(project), []string{"shuttle", "pause", "pause", "--no-kill"}, "pause", func(t *testing.T, body map[string]any) {
			if body["no_kill"] != true {
				t.Fatalf("pause payload = %#v", body)
			}
		}},
		{"resume", felt.StatusOpen, remoteShuttleBlock(project), []string{"shuttle", "resume", "resume"}, "resume", nil},
		{"close", felt.StatusActive, remoteShuttleBlock(project), []string{"shuttle", "close", "close", "--tempered=false"}, "close", func(t *testing.T, body map[string]any) {
			if body["tempered"] != false {
				t.Fatalf("close payload = %#v", body)
			}
		}},
		{"accept", felt.StatusClosed, map[string]any{"kind": "pinned", "host": "worker", "agent": "claude-opus", "project_dir": project}, []string{"shuttle", "accept", "accept"}, "accept", nil},
		{"outcome", felt.StatusActive, remoteShuttleBlock(project), []string{"shuttle", "set-outcome", "outcome", "--outcome", "new outcome"}, "set-outcome", func(t *testing.T, body map[string]any) {
			if body["outcome"] != "new outcome" {
				t.Fatalf("set-outcome payload = %#v", body)
			}
		}},
		{"model", felt.StatusActive, remoteShuttleBlock(project), []string{"shuttle", "set-model", "model", "claude-sonnet"}, "set-model", func(t *testing.T, body map[string]any) {
			if body["agent"] != "claude-sonnet" {
				t.Fatalf("set-model payload = %#v", body)
			}
		}},
		{"agent", felt.StatusActive, remoteShuttleBlock(project), []string{"shuttle", "set-agent", "agent", "claude-sonnet", "--effort", "high", "--chrome=true"}, "set-agent", func(t *testing.T, body map[string]any) {
			if body["agent"] != "claude-sonnet" || body["effort"] != "high" || body["chrome"] != true {
				t.Fatalf("set-agent payload = %#v", body)
			}
		}},
		{"reshape", felt.StatusActive, remoteShuttleBlock(project), []string{"shuttle", "reshape", "reshape", "standing", "--schedule", "0 8 * * *", "--tz", "UTC"}, "reshape", func(t *testing.T, body map[string]any) {
			if body["kind"] != "standing" || body["schedule"] != "0 8 * * *" || body["tz"] != "UTC" {
				t.Fatalf("reshape payload = %#v", body)
			}
		}},
		{"uninstall", felt.StatusActive, remoteShuttleBlock(project), []string{"shuttle", "uninstall", "uninstall"}, "uninstall", nil},
	} {
		t.Run(tc.id, func(t *testing.T) {
			seedShuttleRole(t, storage, tc.id, tc.status, tc.block, nil)
			var got map[string]any
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v1/state/composite" {
					_, _ = w.Write([]byte(`{"remotes":{}}`))
					return
				}
				if r.URL.Path != "/api/v1/lifecycle" {
					t.Errorf("request path = %s, want lifecycle", r.URL.Path)
				}
				if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
					t.Errorf("decode request: %v", err)
				}
				_, _ = w.Write([]byte("forwarded\n"))
			}))
			t.Setenv("SHUTTLE_DAEMON_URL", server.URL)
			if _, err := runCommand(t, dir, tc.args...); err != nil {
				server.Close()
				t.Fatalf("%s: %v", tc.id, err)
			}
			server.Close()
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
			if !fiber.HasShuttleFacet() {
				t.Fatalf("remote lifecycle verb removed the shuttle block from the mirror for %s", tc.id)
			}
		})
	}
}

func TestRemoteLifecycleUnknownOwnerAndLocalDaemonDownRefuseWithCommand(t *testing.T) {
	t.Run("unknown remote", func(t *testing.T) {
		withOwnHost(t, "hub")
		missing := filepath.Join(t.TempDir(), "remotes.json")
		t.Setenv("FELT_REMOTES_FILE", missing)
		dir, storage := newStore(t)
		seedShuttleRole(t, storage, "task", felt.StatusClosed, remoteShuttleBlock(t.TempDir()), nil)
		_, err := runCommand(t, dir, "shuttle", "reopen", "task")
		if err == nil || !strings.Contains(err.Error(), "not an enabled remote") || !strings.Contains(err.Error(), "felt shuttle reopen task") || !strings.Contains(err.Error(), missing) {
			t.Fatalf("unknown-owner refusal = %v", err)
		}
		if mustRead(t, storage, "task").Status != felt.StatusClosed {
			t.Fatal("unknown-owner refusal mutated the mirror")
		}
	})

	t.Run("local daemon down", func(t *testing.T) {
		configureRemoteLifecycleTest(t)
		dir, storage := newStore(t)
		seedShuttleRole(t, storage, "task", felt.StatusClosed, remoteShuttleBlock(t.TempDir()), nil)
		server := httptest.NewServer(http.NotFoundHandler())
		url := server.URL
		server.Close()
		t.Setenv("SHUTTLE_DAEMON_URL", url)
		_, err := runCommand(t, dir, "shuttle", "reopen", "task")
		if err == nil || !strings.Contains(err.Error(), "local shuttle daemon is unreachable") || !strings.Contains(err.Error(), "did not receive the request") || !strings.Contains(err.Error(), "felt shuttle reopen task") {
			t.Fatalf("daemon-down refusal = %v", err)
		}
		if mustRead(t, storage, "task").Status != felt.StatusClosed {
			t.Fatal("daemon-down refusal mutated the mirror")
		}
	})
}

func TestRemoteForwardFailuresSayOwnerUnreachableAndActionMayHaveApplied(t *testing.T) {
	for _, body := range []string{
		"forward to worker failed: :socket_closed_remotely",
		"forward to worker failed: stale origin",
	} {
		t.Run(body, func(t *testing.T) {
			configureRemoteLifecycleTest(t)
			dir, storage := newStore(t)
			seedShuttleRole(t, storage, "task", felt.StatusActive, remoteShuttleBlock(t.TempDir()), nil)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				http.Error(w, body, http.StatusBadGateway)
			}))
			defer server.Close()
			t.Setenv("SHUTTLE_DAEMON_URL", server.URL)
			_, err := runCommand(t, dir, "shuttle", "close", "task")
			if err == nil || !strings.Contains(err.Error(), `owning host "worker" is unreachable`) || !strings.Contains(err.Error(), "action may have been applied") || !strings.Contains(err.Error(), "felt shuttle close task") {
				t.Fatalf("forward failure = %v", err)
			}
			if mustRead(t, storage, "task").Status != felt.StatusActive {
				t.Fatal("forward failure mutated the mirror")
			}
		})
	}
}

func TestRemoteDispatchForwardFailureMapsAmbiguousOwnerOutcome(t *testing.T) {
	configureRemoteLifecycleTest(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "active", felt.StatusActive, remoteShuttleBlock(t.TempDir()), nil)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"dispatched":false,"reason":"forward_failed","origin":"worker","error":"socket_closed_remotely"}`))
	}))
	defer server.Close()
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)

	_, err := runCommand(t, dir, "shuttle", "dispatch", "active")
	if err == nil || !strings.Contains(err.Error(), `owning host "worker" is unreachable`) || !strings.Contains(err.Error(), "action may have been applied") {
		t.Fatalf("dispatch forward failure = %v", err)
	}
	if mustRead(t, storage, "active").Status != felt.StatusActive {
		t.Fatal("dispatch forward failure mutated the hub mirror")
	}
}

func TestRemoteResumeReportsFreshRemoteBootQuarantine(t *testing.T) {
	configureRemoteLifecycleTest(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "draft", felt.StatusOpen, remoteShuttleBlock(t.TempDir()), nil)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/lifecycle":
			_, _ = w.Write([]byte("resumed draft\n"))
		case "/api/v1/state/composite":
			_, _ = w.Write([]byte(`{"remotes":{"worker":{"stale":false,"snapshot":{"boot_quarantine":true}}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)
	out, err := runCommand(t, dir, "shuttle", "resume", "draft")
	if err != nil {
		t.Fatalf("remote resume: %v", err)
	}
	if !strings.Contains(out, "may stay pending") || !strings.Contains(out, "bin/shuttle release") || mustRead(t, storage, "draft").Status != felt.StatusOpen {
		t.Fatalf("resume output = %q; hub mirror status = %q", out, mustRead(t, storage, "draft").Status)
	}
}
