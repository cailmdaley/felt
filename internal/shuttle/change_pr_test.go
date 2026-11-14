package shuttle

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
)

func TestChangePRFetchExactHeadAndStackedBase(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	executable, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	env.Set("PATH", filepath.Dir(executable))
	env.Set("GIT_CONFIG_NOSYSTEM", "1")
	env.Set("GIT_CONFIG_GLOBAL", os.DevNull)
	repo := t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		out, err := env.Command("git", append([]string{"-C", repo}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("%v: %s: %v", args, out, err)
		}
		return strings.TrimSpace(string(out))
	}
	git("init", "-b", "stack")
	git("config", "user.name", "Author")
	git("config", "user.email", "author@example.invalid")
	os.WriteFile(filepath.Join(repo, "code"), []byte("base\n"), 0644)
	git("add", ".")
	git("commit", "-m", "base")
	base := git("rev-parse", "HEAD")
	git("checkout", "-b", "topic")
	os.WriteFile(filepath.Join(repo, "code"), []byte("head\n"), 0644)
	git("commit", "-am", "head")
	head := git("rev-parse", "HEAD")
	git("remote", "add", "origin", t.TempDir())
	git("update-ref", "refs/remotes/origin/stack", head)
	git("config", "url."+repo+".insteadOf", "https://example.invalid/upstream/repo")
	// A misleading local PR branch must never select the base instead of head.
	git("branch", "pr/7", base)
	sysenvtest.FakeCommand(t, env, "gh", fmt.Sprintf(`printf '%%s' '{"number":7,"title":"PR title","url":"https://example.invalid/upstream/repo/pull/7","headRefName":"topic","headRefOid":"%s","baseRefName":"stack","state":"OPEN","isDraft":true,"mergeable":"MERGEABLE","statusCheckRollup":[{"conclusion":"SUCCESS"},{"state":"FAILURE"},{"status":"IN_PROGRESS"}]}'`, head))
	pr, b, h, err := ResolveChangePR(env, repo, 7)
	if err != nil {
		t.Fatal(err)
	}
	if git("rev-parse", h) != head || git("rev-parse", b) != base {
		t.Fatal("wrong fetched commits")
	}
	if b != "refs/shuttle/pr/7/base" || git("rev-parse", "refs/remotes/origin/stack") != head {
		t.Fatal("fetch overwrote the fork's tracking ref")
	}
	if pr.Checks != (ChangeChecks{Total: 3, Passed: 1, Failed: 1, Pending: 1}) || !pr.Draft {
		t.Fatalf("%+v", pr)
	}
	change, _, err := BuildChange(env, repo, b, h, nil)
	if err != nil {
		t.Fatal(err)
	}
	if change.Stats != (ChangeStats{Files: 1, Additions: 1, Deletions: 1}) {
		t.Fatalf("%+v", change.Stats)
	}
}

func TestChangePRMergedBakesTheMergedRange(t *testing.T) {
	t.Parallel()
	for _, squash := range []bool{false, true} {
		env := testEnv(t)
		executable, err := exec.LookPath("git")
		if err != nil {
			t.Fatal(err)
		}
		env.Set("PATH", filepath.Dir(executable))
		env.Set("GIT_CONFIG_NOSYSTEM", "1")
		env.Set("GIT_CONFIG_GLOBAL", os.DevNull)
		repo := t.TempDir()
		git := func(args ...string) string {
			t.Helper()
			out, err := env.Command("git", append([]string{"-C", repo}, args...)...).CombinedOutput()
			if err != nil {
				t.Fatalf("%v: %s: %v", args, out, err)
			}
			return strings.TrimSpace(string(out))
		}
		git("init", "-b", "main")
		git("config", "user.name", "Author")
		git("config", "user.email", "author@example.invalid")
		os.WriteFile(filepath.Join(repo, "code"), []byte("base\n"), 0644)
		os.WriteFile(filepath.Join(repo, "other"), []byte("base\n"), 0644)
		git("add", ".")
		git("commit", "-m", "base")
		git("checkout", "-b", "topic")
		os.WriteFile(filepath.Join(repo, "code"), []byte("head\n"), 0644)
		git("commit", "-am", "head")
		head := git("rev-parse", "HEAD")
		git("checkout", "main")
		os.WriteFile(filepath.Join(repo, "other"), []byte("main moved\n"), 0644)
		git("commit", "-am", "main moved before the merge")
		if squash {
			git("merge", "--squash", "topic")
			git("commit", "-m", "squash")
		} else {
			git("merge", "--no-ff", "-m", "merge", "topic")
		}
		merge := git("rev-parse", "HEAD")
		os.WriteFile(filepath.Join(repo, "other"), []byte("main moved again\n"), 0644)
		git("commit", "-am", "main moved after the merge")
		git("config", "url."+repo+".insteadOf", "https://example.invalid/upstream/repo")
		sysenvtest.FakeCommand(t, env, "gh", fmt.Sprintf(`printf '%%s' '{"number":7,"title":"PR title","url":"https://example.invalid/upstream/repo/pull/7","headRefName":"topic","headRefOid":"%s","baseRefName":"main","state":"MERGED","isDraft":false,"mergeable":"UNKNOWN","statusCheckRollup":[],"mergeCommit":{"oid":"%s"}}'`, head, merge))
		pr, b, h, err := ResolveChangePR(env, repo, 7)
		if err != nil {
			t.Fatal(err)
		}
		if pr.MergeCommit != merge || pr.State != "MERGED" {
			t.Fatalf("squash=%v: %+v", squash, pr)
		}
		if git("rev-parse", h) != merge || git("rev-parse", b) != git("rev-parse", merge+"^1") {
			t.Fatalf("squash=%v: wrong merged range", squash)
		}
		change, _, err := BuildChange(env, repo, b, h, nil)
		if err != nil {
			t.Fatal(err)
		}
		if change.Stats != (ChangeStats{Files: 1, Additions: 1, Deletions: 1}) || change.Files[0].Path != "code" {
			t.Fatalf("squash=%v: %+v", squash, change.Stats)
		}
	}
}
