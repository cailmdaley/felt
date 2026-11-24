package shuttlecli

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

func TestSetHostLocalTakeoverAndRelease(t *testing.T) {
	t.Parallel()
	dir, storage := newStore(t)
	projectDir := filepath.Join(dir, "proj")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}
	env := remoteLifecycleEnv(t)
	env.Set("SHUTTLE_HOST", "host-b")

	f, err := felt.New("task", "Task")
	if err != nil {
		t.Fatal(err)
	}
	f.Status = felt.StatusActive
	block := &shuttle.Block{
		Kind:       "oneshot",
		Host:       "host-a",
		ProjectDir: "/old/host-a/proj",
		Agent:      "claude-opus",
	}
	if err := shuttle.SetConfig(f, block); err != nil {
		t.Fatal(err)
	}
	if err := shuttle.SetRuntimeField(f, "session_uuid", "old-sess-123"); err != nil {
		t.Fatal(err)
	}
	if err := shuttle.SetRuntimeField(f, "tmux_session", "task-old-shuttle"); err != nil {
		t.Fatal(err)
	}
	if err := storage.Write(f); err != nil {
		t.Fatal(err)
	}

	// Active takeover on own host without valid local project_dir must fail.
	if _, _, err := executeIn(t, env, dir, "set-host", "task", "host-b", "--local"); err == nil {
		t.Fatalf("expected active takeover with missing local project_dir to fail")
	}

	// Active takeover with valid local --project-dir succeeds and clears old session coordinates.
	stdout, _, err := executeIn(t, env, dir, "set-host", "task", "host-b", "--project-dir", projectDir, "--local")
	if err != nil {
		t.Fatalf("set-host takeover failed: %v", err)
	}
	if !strings.Contains(stdout, "→ host-b") {
		t.Fatalf("unexpected stdout: %q", stdout)
	}
	updated := mustRead(t, storage, "task")
	gotBlock, ok, err := shuttle.BlockOf(updated)
	if err != nil || !ok {
		t.Fatalf("BlockOf: ok=%v err=%v", ok, err)
	}
	if gotBlock.Host != "host-b" {
		t.Fatalf("host = %q, want host-b", gotBlock.Host)
	}
	if gotBlock.ProjectDir == "" || !strings.HasSuffix(gotBlock.ProjectDir, "proj") {
		t.Fatalf("project_dir = %q, want %q", gotBlock.ProjectDir, projectDir)
	}
	rawBytes, err := os.ReadFile(filepath.Join(dir, ".felt", "task", "task.md"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(rawBytes), "session_uuid") || strings.Contains(string(rawBytes), "tmux_session") {
		t.Fatalf("expected host-local runtime session markers cleared, got:\n%s", string(rawBytes))
	}

	// Outgoing release to another host accepts a remote project_dir without local existence check.
	if _, _, err := executeIn(t, env, dir, "set-host", "task", "host-c", "--project-dir", "/remote/host-c/proj", "--local"); err != nil {
		t.Fatalf("outgoing set-host failed: %v", err)
	}
	released := mustRead(t, storage, "task")
	relBlock, ok, err := shuttle.BlockOf(released)
	if err != nil || !ok {
		t.Fatalf("BlockOf released: ok=%v err=%v", ok, err)
	}
	if relBlock.Host != "host-c" || relBlock.ProjectDir != "/remote/host-c/proj" {
		t.Fatalf("released block = %+v", relBlock)
	}
}

func TestSetHostOrchestratedCallsRehomeEndpoint(t *testing.T) {
	t.Parallel()
	dir, storage := newStore(t)
	env := remoteLifecycleEnv(t)
	env.Set("SHUTTLE_HOST", "host-a")

	f, err := felt.New("task", "Task")
	if err != nil {
		t.Fatal(err)
	}
	f.Status = felt.StatusActive
	if err := shuttle.SetConfig(f, &shuttle.Block{Kind: "oneshot", Host: "host-a", ProjectDir: dir, Agent: "claude-opus"}); err != nil {
		t.Fatal(err)
	}
	if err := storage.Write(f); err != nil {
		t.Fatal(err)
	}

	var got map[string]any
	daemonStub(t, env, map[string]http.HandlerFunc{
		"/api/v1/rehome": func(w http.ResponseWriter, r *http.Request) {
			if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
				t.Errorf("decode: %v", err)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true,"host":"host-b","from_host":"host-a","project_dir":"/srv/proj","previous_host_released":false,"previous_host_warning":"host-a was unreachable"}`))
		},
	})

	stdout, stderr, err := executeIn(t, env, dir, "set-host", "task", "host-b", "--project-dir", "/srv/proj")
	if err != nil {
		t.Fatalf("orchestrated set-host failed: %v", err)
	}
	if got["target_host"] != "host-b" || got["origin"] != "host-a" || got["project_dir"] != "/srv/proj" {
		t.Fatalf("unexpected /api/v1/rehome payload: %#v", got)
	}
	if !strings.Contains(stdout, "moved task: host-a → host-b (/srv/proj)") {
		t.Fatalf("unexpected stdout: %q", stdout)
	}
	if !strings.Contains(stderr, "warning: host-a was unreachable") {
		t.Fatalf("expected warning on stderr, got: %q", stderr)
	}
}
