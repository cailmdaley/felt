package shuttle

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/sysenv"
	"gopkg.in/yaml.v3"
)

func gitRepo(t *testing.T) (*sysenv.Env, string, func(...string) string, func(string, string)) {
	t.Helper()
	env := testEnv(t)
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	env.Set("PATH", filepath.Dir(gitPath))
	env.Set("GIT_CONFIG_NOSYSTEM", "1")
	env.Set("GIT_CONFIG_GLOBAL", os.DevNull)
	repo := t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		out, err := env.Command("git", append([]string{"-C", repo}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %s: %v", args, out, err)
		}
		return strings.TrimSpace(string(out))
	}
	put := func(path, text string) {
		t.Helper()
		full := filepath.Join(repo, path)
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(text), 0644); err != nil {
			t.Fatal(err)
		}
	}
	git("init", "-b", "main")
	git("config", "user.name", "Change Author")
	git("config", "user.email", "author@example.invalid")
	return env, repo, git, put
}

func TestSnapshotWorktreeTakesWorkAsItStands(t *testing.T) {
	t.Parallel()
	env, repo, git, put := gitRepo(t)
	put(".gitignore", "ignored.log\n")
	put("tracked.go", "base\n")
	put("removed.go", "going\n")
	git("add", ".")
	git("commit", "-m", "base")
	base := git("rev-parse", "HEAD")
	git("checkout", "-b", "topic")
	put("tracked.go", "committed\n")
	git("commit", "-am", "Committed subject", "-m", "Committed body.")
	if head, err := SnapshotWorktree(env, repo); err != nil || head != "HEAD" {
		t.Fatalf("clean worktree: %q, %v", head, err)
	}

	put("tracked.go", "edited\n")
	put("staged.go", "staged\n")
	git("add", "staged.go")
	if err := os.Remove(filepath.Join(repo, "removed.go")); err != nil {
		t.Fatal(err)
	}
	put("notes/small.txt", "small\n")
	put("ignored.log", "ignored\n")
	put("big.bin", strings.Repeat("x", 1<<20+1))
	// A scratch repository with no commits lists as an untracked directory.
	if out, err := env.Command("git", "init", "-q", filepath.Join(repo, "scratch")).CombinedOutput(); err != nil {
		t.Fatalf("git init scratch: %v\n%s", err, out)
	}
	refs, status := git("show-ref"), git("status", "--porcelain")
	cached := git("diff", "--cached", "--name-only")

	head, err := SnapshotWorktree(env, repo)
	if err != nil {
		t.Fatal(err)
	}
	if head == "HEAD" {
		t.Fatal("dirty worktree snapshotted as HEAD")
	}
	if again, err := SnapshotWorktree(env, repo); err != nil || again != head {
		t.Fatalf("snapshot is not deterministic: %q then %q: %v", head, again, err)
	}
	if got := git("show-ref"); got != refs {
		t.Fatalf("refs moved:\n%s\nwant\n%s", got, refs)
	}
	if got := git("status", "--porcelain"); got != status {
		t.Fatalf("status moved:\n%s\nwant\n%s", got, status)
	}
	if got := git("diff", "--cached", "--name-only"); got != cached {
		t.Fatalf("index moved: %q, want %q", got, cached)
	}
	if parent := git("rev-parse", head+"^"); parent != git("rev-parse", "HEAD") {
		t.Fatalf("snapshot parent %s", parent)
	}
	files := strings.Fields(git("ls-tree", "-r", "--name-only", head))
	want := []string{".gitignore", "notes/small.txt", "staged.go", "tracked.go"}
	if strings.Join(files, " ") != strings.Join(want, " ") {
		t.Fatalf("snapshot files %v, want %v", files, want)
	}
	if text := git("show", head+":tracked.go"); text != "edited" {
		t.Fatalf("tracked edit: %q", text)
	}

	c, _, err := BuildChange(env, repo, base, head, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Commits) != 2 || c.Commits[1].Subject != UncommittedSubject {
		t.Fatalf("commits: %+v", c.Commits)
	}
	if c.Description != "**Committed subject**\n\nCommitted body.\n\n**Uncommitted changes**" {
		t.Fatalf("description: %q", c.Description)
	}
}

func TestDefaultChangeBaseFollowsTheRemote(t *testing.T) {
	t.Parallel()
	env, repo, git, _ := gitRepo(t)
	git("commit", "--allow-empty", "-m", "base")
	if _, err := DefaultChangeBase(env, t.TempDir()); err == nil || !strings.Contains(err.Error(), "is not a Git repository") {
		t.Fatalf("plain directory: %v", err)
	}
	if _, err := DefaultChangeBase(env, repo); err == nil || !strings.Contains(err.Error(), "shuttle.change.base") {
		t.Fatalf("no remote: %v", err)
	}
	git("update-ref", "refs/remotes/origin/master", "HEAD")
	if base, err := DefaultChangeBase(env, repo); err != nil || base != "origin/master" {
		t.Fatalf("master: %q, %v", base, err)
	}
	git("update-ref", "refs/remotes/origin/main", "HEAD")
	if base, err := DefaultChangeBase(env, repo); err != nil || base != "origin/main" {
		t.Fatalf("main: %q, %v", base, err)
	}
	git("update-ref", "refs/remotes/origin/develop", "HEAD")
	git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop")
	if base, err := DefaultChangeBase(env, repo); err != nil || base != "origin/develop" {
		t.Fatalf("origin/HEAD: %q, %v", base, err)
	}
}

func TestChangeSpecDecodesValidatesAndSurvivesConfigWrites(t *testing.T) {
	t.Parallel()
	f, err := felt.New("change-spec", "Change spec")
	if err != nil {
		t.Fatal(err)
	}
	var node yaml.Node
	if err := yaml.Unmarshal([]byte("kind: oneshot\nproject_dir: /work\nchange:\n  repo: code/sp_validation\n  base: origin/develop\n  prs: [446, 12]\n"), &node); err != nil {
		t.Fatal(err)
	}
	f.ExtraFields = map[string]*yaml.Node{FacetKey: node.Content[0]}
	block, _, err := BlockOf(f)
	if err != nil {
		t.Fatal(err)
	}
	if c := block.Change; c == nil || c.Repo != "code/sp_validation" || c.Base != "origin/develop" || len(c.PRs) != 2 || c.PRs[0] != 446 {
		t.Fatalf("change: %+v", block.Change)
	}
	if errs := Validate(block, nil); len(errs) != 0 {
		t.Fatalf("valid spec refused: %v", errs)
	}
	block.Agent = "claude-opus"
	if err := SetConfig(f, block); err != nil {
		t.Fatal(err)
	}
	out, err := yaml.Marshal(f.ExtraFields[FacetKey])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(out), "change:") != 1 || !strings.Contains(string(out), "origin/develop") {
		t.Fatalf("config write lost or doubled the change:\n%s", out)
	}
	for _, tc := range []struct {
		spec  ChangeSpec
		field string
	}{
		{ChangeSpec{Repo: "/elsewhere"}, "change.repo"},
		{ChangeSpec{Repo: "../sibling"}, "change.repo"},
		{ChangeSpec{PRs: []int{3, 0}}, "change.prs[1]"},
		{ChangeSpec{PRs: []int{-2}}, "change.prs[0]"},
	} {
		errs := Validate(&Block{Kind: "oneshot", Change: &tc.spec}, nil)
		if len(errs) != 1 || errs[0].Field != tc.field {
			t.Errorf("%+v: %v, want one %s error", tc.spec, errs, tc.field)
		}
	}
}
