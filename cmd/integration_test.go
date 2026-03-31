//go:build integration

package cmd_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

var binaryPath string

func TestMain(m *testing.M) {
	tmp, err := os.MkdirTemp("", "felt-integration-*")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(tmp)

	binaryPath = filepath.Join(tmp, "felt")
	buildCmd := exec.Command("go", "build", "-o", binaryPath, ".")
	buildCmd.Dir = filepath.Join(filepath.Dir(tmp), "..", "..")
	// Walk up to find go.mod
	dir, _ := os.Getwd()
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			buildCmd.Dir = dir
			break
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	out, err := buildCmd.CombinedOutput()
	if err != nil {
		panic("build failed: " + string(out))
	}
	if err := os.Chmod(binaryPath, 0755); err != nil {
		panic("chmod failed: " + err.Error())
	}

	os.Exit(m.Run())
}

// felt runs the binary in dir with args, returns stdout+stderr.
func felt(dir string, args ...string) (string, error) {
	cmd := exec.Command(binaryPath, args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// mustFelt runs felt and fails the test on error.
func mustFelt(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := felt(dir, args...)
	if err != nil {
		t.Fatalf("felt %v failed: %v\n%s", args, err, out)
	}
	return out
}

func TestIntegration(t *testing.T) {
	dir := t.TempDir()

	// init
	mustFelt(t, dir, "init")
	if _, err := os.Stat(filepath.Join(dir, ".felt")); err != nil {
		t.Fatal("init: .felt directory not created")
	}
	if _, err := os.Stat(filepath.Join(dir, ".felt", "myst.yml")); err != nil {
		t.Fatal("init: myst.yml not created")
	}

	// add — returns the fiber ID
	fiberID := strings.TrimSpace(mustFelt(t, dir, "add", "test fiber", "-s", "open"))
	if fiberID != "test-fiber" {
		t.Fatal("add: expected fiber ID in output")
	}

	// ls
	out := mustFelt(t, dir, "ls")
	if !strings.Contains(out, "test fiber") {
		t.Fatalf("ls: expected fiber in output, got: %s", out)
	}

	// show
	out = mustFelt(t, dir, "show", fiberID)
	if !strings.Contains(out, "test fiber") {
		t.Fatalf("show: expected fiber title, got: %s", out)
	}

	// edit — mark active
	mustFelt(t, dir, "edit", fiberID, "-s", "active")
	out = mustFelt(t, dir, "show", fiberID, "-d", "compact")
	if !strings.Contains(out, "active") {
		t.Fatalf("edit: expected active status, got: %s", out)
	}

	// edit with no flags should fail (agent-first, non-interactive)
	out, err := felt(dir, "edit", fiberID)
	if err == nil {
		t.Fatal("edit without flags: expected error")
	}
	if !strings.Contains(out, "no changes requested") {
		t.Fatalf("edit without flags: expected helpful error, got: %s", out)
	}

	// initial body set on empty body should be a normal update (not overwrite warning)
	out = mustFelt(t, dir, "edit", fiberID, "--body", "initial body")
	if strings.Contains(out, "body overwritten") {
		t.Fatalf("edit --body first set: should not warn overwrite, got: %s", out)
	}

	// replacing non-empty body should be called out as overwrite
	out = mustFelt(t, dir, "edit", fiberID, "--body", "replacement body")
	if !strings.Contains(out, "body overwritten") {
		t.Fatalf("edit --body replace: expected overwrite message, got: %s", out)
	}
	out = mustFelt(t, dir, "show", fiberID, "--body")
	if !strings.Contains(out, "replacement body") {
		t.Fatalf("edit --body: expected replacement content, got: %s", out)
	}
	out = mustFelt(t, dir, "ls", "-e", "test fiber")
	if !strings.Contains(out, fiberID) {
		t.Fatalf("ls --exact should match exact title from metadata, got: %s", out)
	}
	out = mustFelt(t, dir, "ls", "completed successfully")
	if strings.Contains(out, fiberID) {
		t.Fatalf("ls query should not match outcome before it exists, got: %s", out)
	}
	out = mustFelt(t, dir, "ls", "replacement")
	if strings.Contains(out, fiberID) {
		t.Fatalf("ls query without --body should not match body text, got: %s", out)
	}
	out = mustFelt(t, dir, "ls", "--body", "replacement")
	if !strings.Contains(out, fiberID) {
		t.Fatalf("ls query with --body should match body text, got: %s", out)
	}
	out = mustFelt(t, dir, "ls", "--json", "--body")
	var listed []map[string]any
	if err := json.Unmarshal([]byte(out), &listed); err != nil {
		t.Fatalf("ls --json --body: invalid json: %v\n%s", err, out)
	}
	if len(listed) != 1 || listed[0]["body"] != "replacement body" {
		t.Fatalf("ls --json --body: expected hydrated body, got: %#v", listed)
	}

	// comment
	mustFelt(t, dir, "edit", fiberID, "--comment", "a test comment")

	// close with outcome
	mustFelt(t, dir, "edit", fiberID, "-s", "closed", "-o", "completed successfully")
	out = mustFelt(t, dir, "show", fiberID, "-d", "compact")
	if !strings.Contains(out, "completed successfully") {
		t.Fatalf("edit close: expected outcome, got: %s", out)
	}
	out = mustFelt(t, dir, "ls", "completed successfully")
	if !strings.Contains(out, fiberID) {
		t.Fatalf("ls query should match outcome text from metadata, got: %s", out)
	}
	out = mustFelt(t, dir, "ls", "-r", "completed\\s+successfully")
	if !strings.Contains(out, fiberID) {
		t.Fatalf("ls regex query should match outcome text from metadata, got: %s", out)
	}

	// add a second fiber and link them
	fiber2ID := strings.TrimSpace(mustFelt(t, dir, "add", "second fiber", "-s", "open"))
	if fiber2ID == "" {
		t.Fatal("add: expected fiber2 ID")
	}

	// link and unlink
	mustFelt(t, dir, "edit", fiber2ID, "--link", fiberID)
	out = mustFelt(t, dir, "tree", fiber2ID, "--up")
	if !strings.Contains(out, "test fiber") {
		t.Fatalf("upstream: expected dep fiber, got: %s", out)
	}
	mustFelt(t, dir, "edit", fiber2ID, "--unlink", fiberID)

	// downstream: fiber2 depends on fiberID → fiberID is upstream of fiber2
	mustFelt(t, dir, "edit", fiber2ID, "--link", fiberID)
	out = mustFelt(t, dir, "tree", fiberID, "--down")
	if !strings.Contains(out, "second fiber") {
		t.Fatalf("downstream: expected child fiber, got: %s", out)
	}
	fiber3ID := strings.TrimSpace(mustFelt(t, dir, "add", "third fiber", "-s", "open"))
	if fiber3ID == "" {
		t.Fatal("add: expected fiber3 ID")
	}
	mustFelt(t, dir, "edit", fiber3ID, "--link", fiber2ID)

	// Traversal defaults to direct neighbors only.
	out = mustFelt(t, dir, "tree", fiberID, "--down")
	if strings.Contains(out, "third fiber") {
		t.Fatalf("downstream default: expected direct dependents only, got: %s", out)
	}
	// --all includes transitive dependents.
	out = mustFelt(t, dir, "tree", fiberID, "--down", "--all")
	if !strings.Contains(out, "second fiber") || !strings.Contains(out, "third fiber") {
		t.Fatalf("downstream --all: expected transitive closure, got: %s", out)
	}

	out = mustFelt(t, dir, "tree", fiber3ID, "--up")
	if strings.Contains(out, "test fiber") || !strings.Contains(out, "second fiber") {
		t.Fatalf("upstream default: expected direct dependencies only, got: %s", out)
	}
	out = mustFelt(t, dir, "tree", fiber3ID, "--up", "--all")
	if !strings.Contains(out, "second fiber") || !strings.Contains(out, "test fiber") {
		t.Fatalf("upstream --all: expected transitive closure, got: %s", out)
	}

	// tag and untag
	mustFelt(t, dir, "edit", fiber2ID, "--tag", "testlabel")
	out = mustFelt(t, dir, "show", fiber2ID, "-d", "compact")
	if !strings.Contains(out, "testlabel") {
		t.Fatalf("tag: expected tag in output, got: %s", out)
	}
	mustFelt(t, dir, "edit", fiber2ID, "--untag", "testlabel")

	// ready
	mustFelt(t, dir, "ls", "--ready")

	// rm --force
	mustFelt(t, dir, "rm", "--force", fiber3ID)
	mustFelt(t, dir, "rm", "--force", fiber2ID)
	lsOut := mustFelt(t, dir, "ls", "-s", "all")
	if strings.Contains(lsOut, "second fiber") {
		t.Fatalf("rm: fiber should be gone, got: %s", lsOut)
	}

	// setup claude — should print snippet
	out = mustFelt(t, dir, "setup", "claude")
	if !strings.Contains(out, "## felt") {
		t.Fatalf("setup claude: expected CLAUDE.md snippet, got: %s", out)
	}

	// setup codex — install, idempotent, uninstall
	codexHome := t.TempDir()
	codexEnv := append(os.Environ(), "HOME="+codexHome, "SHELL=/bin/zsh")

	cmd := exec.Command(binaryPath, "setup", "codex")
	cmd.Dir = dir
	cmd.Env = codexEnv
	cmdOut, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("setup codex install: %v\n%s", err, cmdOut)
	}
	if !strings.Contains(string(cmdOut), "## felt") {
		t.Fatalf("setup codex: expected AGENTS.md snippet, got: %s", cmdOut)
	}

	rcPath := filepath.Join(codexHome, ".zshrc")
	rcContent, _ := os.ReadFile(rcPath)
	if !strings.Contains(string(rcContent), "felt integration") {
		t.Fatalf("setup codex: wrapper not written to .zshrc")
	}

	// idempotent
	cmd2 := exec.Command(binaryPath, "setup", "codex")
	cmd2.Dir = dir
	cmd2.Env = codexEnv
	cmdOut2, _ := cmd2.CombinedOutput()
	if !strings.Contains(string(cmdOut2), "already installed") {
		t.Fatalf("setup codex idempotency: expected 'already installed', got: %s", cmdOut2)
	}

	// uninstall
	cmd3 := exec.Command(binaryPath, "setup", "codex", "--uninstall")
	cmd3.Dir = dir
	cmd3.Env = codexEnv
	cmd3Out, err := cmd3.CombinedOutput()
	if err != nil {
		t.Fatalf("setup codex uninstall: %v\n%s", err, cmd3Out)
	}
	rcContent2, _ := os.ReadFile(rcPath)
	if strings.Contains(string(rcContent2), "felt integration") {
		t.Fatalf("setup codex uninstall: wrapper still in .zshrc")
	}
}
