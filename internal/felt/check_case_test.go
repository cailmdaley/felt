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
	t.Parallel()
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

// A tracked file or directory spelled differently on disk than in the index is
// one entry, not a collision: git status is clean on a case-insensitive
// filesystem, and a case-sensitive one holds a single entry either way.
func TestCheckCaseCollisionsIgnoresDiskRespelling(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()
	fiberDir := filepath.Join(s.root, "project", "review")
	notesDir := filepath.Join(s.root, "Notes")
	os.MkdirAll(fiberDir, 0o755)
	os.MkdirAll(notesDir, 0o755)
	os.WriteFile(filepath.Join(fiberDir, "review.md"), []byte("---\nname: review\n---\n"), 0o644)
	os.WriteFile(filepath.Join(fiberDir, "REPORT.txt"), []byte("report\n"), 0o644)
	os.WriteFile(filepath.Join(notesDir, "notes.md"), []byte("---\nname: notes\n---\n"), 0o644)
	gitIn(t, dir, "init", "-q")
	gitIn(t, dir, "add", ".")
	gitIn(t, dir, "commit", "-q", "-m", "init")

	if err := os.Rename(filepath.Join(fiberDir, "REPORT.txt"), filepath.Join(fiberDir, "report.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(notesDir, filepath.Join(s.root, "notes")); err != nil {
		t.Fatal(err)
	}

	issues, err := CheckCaseCollisions(s)
	if err != nil {
		t.Fatalf("CheckCaseCollisions: %v", err)
	}
	if len(issues) != 0 {
		t.Fatalf("a respelled tracked entry was reported: %+v", issues)
	}
}

// A view whose .felt symlinks into the repository through a spelling the index
// does not record (project, on disk and in the link, for the index's Project)
// still sees the index twins.
func TestCheckCaseCollisionsThroughRespelledSymlink(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	repo := t.TempDir()
	fiberDir := filepath.Join(repo, ".felt", "Project", "review")
	os.MkdirAll(fiberDir, 0o755)
	os.WriteFile(filepath.Join(fiberDir, "review.md"), []byte("---\nname: review\n---\n"), 0o644)
	os.WriteFile(filepath.Join(fiberDir, "REPORT.md"), []byte("report\n"), 0o644)
	gitIn(t, repo, "init", "-q")
	gitIn(t, repo, "add", ".")
	blob := gitIn(t, repo, "hash-object", "-w", filepath.Join(fiberDir, "REPORT.md"))
	gitIn(t, repo, "update-index", "--add", "--cacheinfo", "100644,"+blob+",.felt/Project/review/report.md")
	if err := os.Rename(filepath.Join(repo, ".felt", "Project"), filepath.Join(repo, ".felt", "project")); err != nil {
		t.Fatal(err)
	}

	view := t.TempDir()
	if err := os.Symlink(filepath.Join(repo, ".felt", "project"), filepath.Join(view, ".felt")); err != nil {
		t.Fatal(err)
	}

	issues, err := CheckCaseCollisions(NewStorage(view))
	if err != nil {
		t.Fatalf("CheckCaseCollisions: %v", err)
	}
	if len(issues) != 1 || issues[0].FiberID != "review" || !strings.Contains(issues[0].Message, `"REPORT.md" and "report.md"`) {
		t.Fatalf("issues = %+v, want the REPORT.md/report.md pair under review", issues)
	}
}

// indexTwins builds a repository at repo holding .felt/project/review with
// REPORT.md on disk and report.md added to the index alone.
func indexTwins(t *testing.T, repo string) {
	t.Helper()
	fiberDir := filepath.Join(repo, ".felt", "project", "review")
	os.MkdirAll(fiberDir, 0o755)
	os.WriteFile(filepath.Join(fiberDir, "review.md"), []byte("---\nname: review\n---\n"), 0o644)
	os.WriteFile(filepath.Join(fiberDir, "REPORT.md"), []byte("report\n"), 0o644)
	gitIn(t, repo, "init", "-q")
	gitIn(t, repo, "add", ".")
	blob := gitIn(t, repo, "hash-object", "-w", filepath.Join(fiberDir, "REPORT.md"))
	gitIn(t, repo, "update-index", "--add", "--cacheinfo", "100644,"+blob+",.felt/project/review/report.md")
}

func wantReportTwins(t *testing.T, s *Storage) {
	t.Helper()
	issues, err := CheckCaseCollisions(s)
	if err != nil {
		t.Fatalf("CheckCaseCollisions: %v", err)
	}
	if len(issues) != 1 || issues[0].FiberID != "review" || !strings.Contains(issues[0].Message, `"REPORT.md" and "report.md"`) {
		t.Fatalf("issues = %+v, want the REPORT.md/report.md pair under review", issues)
	}
}

// A view reaching the repository through a respelled ancestor (repo for
// Repo) still sees the index twins. Only a case-insensitive filesystem
// resolves that symlink.
func TestCheckCaseCollisionsThroughRespelledRepoAncestor(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	parent := t.TempDir()
	indexTwins(t, filepath.Join(parent, "Repo"))
	view := t.TempDir()
	if err := os.Symlink(filepath.Join(parent, "repo", ".felt", "project"), filepath.Join(view, ".felt")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(view, ".felt")); err != nil {
		t.Skip("case-sensitive filesystem: the respelled symlink does not resolve")
	}
	wantReportTwins(t, NewStorage(view))
}

// A trailing space in the repository's name is part of the name, not
// whitespace around git's output.
func TestCheckCaseCollisionsRepoNameWithTrailingSpace(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	repo := filepath.Join(t.TempDir(), "repo ")
	os.MkdirAll(repo, 0o755)
	indexTwins(t, repo)
	view := t.TempDir()
	if err := os.Symlink(filepath.Join(repo, ".felt", "project"), filepath.Join(view, ".felt")); err != nil {
		t.Fatal(err)
	}
	wantReportTwins(t, NewStorage(view))
}
