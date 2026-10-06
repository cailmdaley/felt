//go:build !integration

package shuttlecli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The tests below give a relative path argument to an env whose working
// directory is not the test process's, and check the command read or wrote
// it there.

func TestMessageFileAndAttachmentsResolveInTheInvocationDirectory(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	cwd := t.TempDir()
	env.Chdir(cwd)
	if err := os.WriteFile(filepath.Join(cwd, "relative-note.txt"), []byte("from the invocation directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	req, err := newApp(env).buildMessageRequest(strings.NewReader(""), []string{"addr"}, &messageOptions{
		file:        "relative-note.txt",
		attachments: []string{"relative-note.txt"},
	})
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	if req.Text != "from the invocation directory" {
		t.Fatalf("text = %q", req.Text)
	}
	if len(req.Attachments) != 1 || string(req.Attachments[0].Data) != "from the invocation directory" || req.Attachments[0].Name != "relative-note.txt" {
		t.Fatalf("attachments = %#v", req.Attachments)
	}
}

func TestAgentsInitWritesARelativePathInTheInvocationDirectory(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	cwd := t.TempDir()
	env.Chdir(cwd)
	if _, _, err := runAgents(t, env, "agents", "init", "--path", "relative-agents.json"); err != nil {
		t.Fatalf("init: %v", err)
	}
	if _, err := os.Stat(filepath.Join(cwd, "relative-agents.json")); err != nil {
		t.Fatalf("seeded registry not in the invocation directory: %v", err)
	}
}

func TestSessionsMaterializeWritesARelativeDirInTheInvocationDirectory(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	provenanceDaemon(t, env, []byte("{\"type\":\"response_item\"}\n"))
	env.Set("SHUTTLE_TRANSCRIPT_CACHE_DIR", t.TempDir())
	cwd := t.TempDir()
	env.Chdir(cwd)
	out, _, err := executeIn(t, env, t.TempDir(), "sessions", "new/name", "--materialize", "--dir", "relative-transcripts", "--json")
	if err != nil {
		t.Fatalf("materialize: %v\n%s", err, out)
	}
	var result struct {
		Manifest string `json:"manifest"`
	}
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(cwd, "relative-transcripts", "manifest.json"); result.Manifest != want {
		t.Fatalf("manifest = %q, want %q", result.Manifest, want)
	}
	if _, err := os.Stat(result.Manifest); err != nil {
		t.Fatal(err)
	}
}

func TestDaemonInstallLogResolvesInTheInvocationDirectory(t *testing.T) {
	t.Parallel()
	release := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "release"))
	share := filepath.Join(release.Dir, "share")
	if err := os.MkdirAll(share, 0o755); err != nil {
		t.Fatal(err)
	}
	name := "io.shuttle.daemon.service.template"
	if err := os.WriteFile(filepath.Join(share, name), []byte(supervisorTemplateFixtures()[name]), 0o644); err != nil {
		t.Fatal(err)
	}
	env, home := envWithHome(t)
	env.Set("SHUTTLE_RELEASE", release.Dir)
	env.Set("SHUTTLE_STORES_FILE", filepath.Join(home, "stores.json"))
	cwd := t.TempDir()
	env.Chdir(cwd)
	a := stubLoginEnv(env, loginEnv{Path: "/captured"})
	out, stderr, err := executeApp(t, a, t.TempDir(), "daemon", "install", "--print", "--os", "Linux", "--path", "/bin", "--log", "relative-logs/shuttle.log")
	if err != nil {
		t.Fatalf("daemon install --print: %v\n%s", err, stderr)
	}
	if want := "append:" + filepath.Join(cwd, "relative-logs", "shuttle.log"); !strings.Contains(out, want) {
		t.Fatalf("unit does not log to %s:\n%s", want, out)
	}
}
