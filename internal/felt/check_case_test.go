package felt

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// The twins only coexist in the git index here, as on a macOS checkout: the
// index entries are added without a second file on disk.
func TestCheckCaseCollisionsInGitIndex(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()
	fiberDir := filepath.Join(s.root, "project", "review")
	os.MkdirAll(fiberDir, 0o755)
	os.WriteFile(filepath.Join(fiberDir, "review.md"), []byte("---\nname: review\n---\n"), 0o644)
	os.WriteFile(filepath.Join(fiberDir, "REPORT.md"), []byte("report\n"), 0o644)
	gitIn(t, dir, "init", "-q")
	gitIn(t, dir, "add", ".")

	issues, err := CheckCaseCollisions(s)
	if err != nil {
		t.Fatalf("CheckCaseCollisions: %v", err)
	}
	if len(issues) != 0 {
		t.Fatalf("clean store reported %+v", issues)
	}

	blob := gitIn(t, dir, "hash-object", "-w", filepath.Join(fiberDir, "REPORT.md"))
	for _, p := range []string{".felt/project/review/report.md", ".felt/Project/other/other.md", ".felt/Project/other/deeper/x.md"} {
		gitIn(t, dir, "update-index", "--add", "--cacheinfo", "100644,"+blob+","+p)
	}

	issues, err = CheckCaseCollisions(s)
	if err != nil {
		t.Fatalf("CheckCaseCollisions: %v", err)
	}
	if len(issues) != 2 {
		t.Fatalf("issues = %+v, want the file pair and the directory pair", issues)
	}
	byFiber := map[string]string{}
	for _, issue := range issues {
		if issue.Level != CheckLevelError {
			t.Errorf("issue %+v is not an error", issue)
		}
		byFiber[issue.FiberID] = issue.Message
	}
	if msg := byFiber["."]; !strings.Contains(msg, `"Project" and "project"`) {
		t.Errorf("directory collision message = %q", msg)
	}
	if msg := byFiber["project/review"]; !strings.Contains(msg, `"REPORT.md" and "report.md"`) {
		t.Errorf("file collision message = %q", msg)
	}
}
