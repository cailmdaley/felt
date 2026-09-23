package cmd

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/spf13/cobra"
)

type syncFixture struct {
	root   string
	remote string
	clone  string
}

func newSyncFixture(t *testing.T) syncFixture {
	t.Helper()
	base := t.TempDir()
	f := syncFixture{root: base, remote: filepath.Join(base, "remote.git"), clone: filepath.Join(base, "clone")}
	syncTestGit(t, base, "init", "--bare", f.remote)
	syncTestGit(t, base, "clone", f.remote, f.clone)
	syncTestGit(t, f.clone, "config", "user.name", "Sync Test")
	syncTestGit(t, f.clone, "config", "user.email", "sync-test@example.invalid")
	writeSyncFile(t, f.clone, "base.md", "base\n")
	syncTestGit(t, f.clone, "add", "base.md")
	syncTestGit(t, f.clone, "commit", "-m", "base")
	syncTestGit(t, f.clone, "push", "-u", "origin", "HEAD")
	return f
}

func syncTestGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v in %s: %v\n%s", args, dir, err, out)
	}
	return strings.TrimSpace(string(out))
}

func writeSyncFile(t *testing.T, dir, name, body string) {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0644); err != nil {
		t.Fatal(err)
	}
}

func runFixtureSync(t *testing.T, f syncFixture, push bool) (string, error) {
	t.Helper()
	var out bytes.Buffer
	err := syncStore(context.Background(), f.clone, push, &out)
	return out.String(), err
}

func TestSyncNoopFastForwardAndDivergentMerge(t *testing.T) {
	t.Run("no-op", func(t *testing.T) {
		f := newSyncFixture(t)
		_, err := runFixtureSync(t, f, false)
		if err != nil {
			t.Fatal(err)
		}
	})
	t.Run("fast-forward", func(t *testing.T) {
		f := newSyncFixture(t)
		peer := filepath.Join(f.root, "peer")
		syncTestGit(t, f.root, "clone", f.remote, peer)
		syncTestGit(t, peer, "config", "user.name", "Peer")
		syncTestGit(t, peer, "config", "user.email", "peer@example.invalid")
		writeSyncFile(t, peer, "upstream.md", "upstream\n")
		syncTestGit(t, peer, "add", "upstream.md")
		syncTestGit(t, peer, "commit", "-m", "upstream")
		syncTestGit(t, peer, "push")
		_, err := runFixtureSync(t, f, false)
		if err != nil {
			t.Fatal(err)
		}
		if got := syncTestGit(t, f.clone, "show", "HEAD:upstream.md"); got != "upstream" {
			t.Fatalf("fast-forward file = %q", got)
		}
	})
	t.Run("divergent clean merge", func(t *testing.T) {
		f := newSyncFixture(t)
		peer := filepath.Join(f.root, "peer")
		syncTestGit(t, f.root, "clone", f.remote, peer)
		syncTestGit(t, peer, "config", "user.name", "Peer")
		syncTestGit(t, peer, "config", "user.email", "peer@example.invalid")
		writeSyncFile(t, f.clone, "local.md", "local\n")
		syncTestGit(t, f.clone, "add", "local.md")
		syncTestGit(t, f.clone, "commit", "-m", "local")
		syncTestGit(t, f.clone, "config", "merge.ff", "only")
		writeSyncFile(t, peer, "upstream.md", "upstream\n")
		syncTestGit(t, peer, "add", "upstream.md")
		syncTestGit(t, peer, "commit", "-m", "upstream")
		syncTestGit(t, peer, "push")
		_, err := runFixtureSync(t, f, false)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(syncTestGit(t, f.clone, "log", "--format=%P", "-1"), " ") {
			t.Fatal("sync did not create a two-parent merge commit")
		}
	})
}

func TestSyncConflictRetainsStagesAndRetryAfterResolution(t *testing.T) {
	f := newSyncFixture(t)
	peer := filepath.Join(f.root, "peer")
	syncTestGit(t, f.root, "clone", f.remote, peer)
	syncTestGit(t, peer, "config", "user.name", "Peer")
	syncTestGit(t, peer, "config", "user.email", "peer@example.invalid")
	writeSyncFile(t, f.clone, "base.md", "local\n")
	syncTestGit(t, f.clone, "add", "base.md")
	syncTestGit(t, f.clone, "commit", "-m", "local edit")
	writeSyncFile(t, peer, "base.md", "remote\n")
	syncTestGit(t, peer, "add", "base.md")
	syncTestGit(t, peer, "commit", "-m", "remote edit")
	syncTestGit(t, peer, "push")
	_, err := runFixtureSync(t, f, false)
	if err == nil || !strings.Contains(err.Error(), "resolve and commit") {
		t.Fatalf("conflict error = %v", err)
	}
	if got := syncTestGit(t, f.clone, "ls-files", "--unmerged"); got == "" {
		t.Fatal("conflict stages were not retained")
	}
	_, err = runFixtureSync(t, f, false)
	if err == nil || !strings.Contains(err.Error(), "Git operation \"MERGE_HEAD\" is in progress") {
		t.Fatalf("retry during unresolved merge = %v", err)
	}
	writeSyncFile(t, f.clone, "base.md", "resolved\n")
	syncTestGit(t, f.clone, "add", "base.md")
	syncTestGit(t, f.clone, "commit", "-m", "resolve")
	if _, err := runFixtureSync(t, f, false); err != nil {
		t.Fatalf("retry after resolution: %v", err)
	}
}

func TestSyncStagedRefusalAndSafeUnstagedUntrackedState(t *testing.T) {
	t.Run("staged refused", func(t *testing.T) {
		f := newSyncFixture(t)
		writeSyncFile(t, f.clone, "staged.md", "keep\n")
		syncTestGit(t, f.clone, "add", "staged.md")
		_, err := runFixtureSync(t, f, false)
		if err == nil || !strings.Contains(err.Error(), "staged changes") {
			t.Fatalf("staged change error = %v", err)
		}
		if got := syncTestGit(t, f.clone, "rev-parse", "HEAD"); got != syncTestGit(t, f.clone, "rev-parse", "@{upstream}") {
			t.Fatal("staged refusal changed the branch")
		}
	})
	t.Run("non-overlapping unstaged and untracked survive fast-forward", func(t *testing.T) {
		f := newSyncFixture(t)
		peer := filepath.Join(f.root, "peer")
		syncTestGit(t, f.root, "clone", f.remote, peer)
		syncTestGit(t, peer, "config", "user.name", "Peer")
		syncTestGit(t, peer, "config", "user.email", "peer@example.invalid")
		writeSyncFile(t, peer, "upstream.md", "upstream\n")
		syncTestGit(t, peer, "add", "upstream.md")
		syncTestGit(t, peer, "commit", "-m", "upstream")
		syncTestGit(t, peer, "push")
		writeSyncFile(t, f.clone, "base.md", "unstaged\n")
		writeSyncFile(t, f.clone, "untracked.md", "untracked\n")
		syncTestGit(t, f.clone, "config", "merge.autoStash", "true")
		if _, err := runFixtureSync(t, f, false); err != nil {
			t.Fatal(err)
		}
		if got := syncTestGit(t, f.clone, "stash", "list"); got != "" {
			t.Fatalf("sync created a stash despite preserving dirty work: %s", got)
		}
		for name, want := range map[string]string{"base.md": "unstaged\n", "untracked.md": "untracked\n", "upstream.md": "upstream\n"} {
			got, err := os.ReadFile(filepath.Join(f.clone, name))
			if err != nil || string(got) != want {
				t.Fatalf("%s = %q, %v; want %q", name, got, err, want)
			}
		}
	})
	t.Run("overlap refused and preserved", func(t *testing.T) {
		f := newSyncFixture(t)
		peer := filepath.Join(f.root, "peer")
		syncTestGit(t, f.root, "clone", f.remote, peer)
		syncTestGit(t, peer, "config", "user.name", "Peer")
		syncTestGit(t, peer, "config", "user.email", "peer@example.invalid")
		writeSyncFile(t, peer, "base.md", "remote\n")
		syncTestGit(t, peer, "add", "base.md")
		syncTestGit(t, peer, "commit", "-m", "upstream")
		syncTestGit(t, peer, "push")
		writeSyncFile(t, f.clone, "base.md", "local unstaged\n")
		_, err := runFixtureSync(t, f, false)
		if err == nil {
			t.Fatal("overlapping unstaged change should block Git merge")
		}
		got, readErr := os.ReadFile(filepath.Join(f.clone, "base.md"))
		if readErr != nil || string(got) != "local unstaged\n" {
			t.Fatalf("local edit changed: %q, %v", got, readErr)
		}
	})
	t.Run("untracked collision refused and preserved", func(t *testing.T) {
		f := newSyncFixture(t)
		peer := filepath.Join(f.root, "peer")
		syncTestGit(t, f.root, "clone", f.remote, peer)
		syncTestGit(t, peer, "config", "user.name", "Peer")
		syncTestGit(t, peer, "config", "user.email", "peer@example.invalid")
		writeSyncFile(t, peer, "untracked-collision.md", "upstream\n")
		syncTestGit(t, peer, "add", "untracked-collision.md")
		syncTestGit(t, peer, "commit", "-m", "upstream")
		syncTestGit(t, peer, "push")
		writeSyncFile(t, f.clone, "untracked-collision.md", "local untracked\n")
		_, err := runFixtureSync(t, f, false)
		if err == nil {
			t.Fatal("untracked file collision should block Git merge")
		}
		got, readErr := os.ReadFile(filepath.Join(f.clone, "untracked-collision.md"))
		if readErr != nil || string(got) != "local untracked\n" {
			t.Fatalf("untracked file changed: %q, %v", got, readErr)
		}
	})
}

func TestSyncIgnoredCollisionPreservesLocalBytes(t *testing.T) {
	f := newSyncFixture(t)
	peer := filepath.Join(f.root, "peer")
	syncTestGit(t, f.root, "clone", f.remote, peer)
	syncTestGit(t, peer, "config", "user.name", "Peer")
	syncTestGit(t, peer, "config", "user.email", "peer@example.invalid")
	name := "ignored-collision.md"
	writeSyncFile(t, filepath.Join(f.clone, ".git", "info"), "exclude", name+"\n")
	writeSyncFile(t, f.clone, name, "local ignored bytes\n")
	writeSyncFile(t, peer, name, "upstream tracked bytes\n")
	syncTestGit(t, peer, "add", name)
	syncTestGit(t, peer, "commit", "-m", "track ignored collision")
	syncTestGit(t, peer, "push")

	_, err := runFixtureSync(t, f, false)
	if err == nil {
		t.Fatal("sync should refuse to overwrite an ignored local file")
	}
	got, readErr := os.ReadFile(filepath.Join(f.clone, name))
	if readErr != nil || string(got) != "local ignored bytes\n" {
		t.Fatalf("ignored local file changed: %q, %v", got, readErr)
	}
}

func TestSyncPushTargetsTrackingBranchAndReportsRejection(t *testing.T) {
	f := newSyncFixture(t)
	wrongRemote := filepath.Join(f.root, "wrong.git")
	syncTestGit(t, f.root, "init", "--bare", wrongRemote)
	syncTestGit(t, f.clone, "remote", "add", "wrong", wrongRemote)
	branch := syncTestGit(t, f.clone, "branch", "--show-current")
	syncTestGit(t, f.clone, "config", "push.default", "matching")
	syncTestGit(t, f.clone, "config", "branch."+branch+".pushRemote", "wrong")
	writeSyncFile(t, f.clone, "local.md", "local\n")
	syncTestGit(t, f.clone, "add", "local.md")
	syncTestGit(t, f.clone, "commit", "-m", "local")
	_, err := runFixtureSync(t, f, true)
	if err != nil {
		t.Fatal(err)
	}
	trackingRef := syncTestGit(t, f.clone, "for-each-ref", "--format=%(upstream:remoteref)", "refs/heads/"+branch)
	if got := syncTestGit(t, f.remote, "rev-parse", trackingRef); got != syncTestGit(t, f.clone, "rev-parse", "HEAD") {
		t.Fatalf("tracking branch was not pushed: %s != %s", got, syncTestGit(t, f.clone, "rev-parse", "HEAD"))
	}
	if got := syncTestGit(t, wrongRemote, "for-each-ref", "--format=%(refname)"); got != "" {
		t.Fatalf("sync pushed to configured pushRemote instead of tracking remote: %s", got)
	}

	// A hook gives deterministic rejection after the local fetch/merge succeeds.
	hook := filepath.Join(f.clone, ".git", "hooks", "pre-push")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\necho rejected >&2\nexit 1\n"), 0755); err != nil {
		t.Fatal(err)
	}
	writeSyncFile(t, f.clone, "another.md", "another\n")
	syncTestGit(t, f.clone, "add", "another.md")
	syncTestGit(t, f.clone, "commit", "-m", "another")
	_, err = runFixtureSync(t, f, true)
	if err == nil || !strings.Contains(err.Error(), "push failed after local sync") {
		t.Fatalf("push rejection = %v", err)
	}
	if got := syncTestGit(t, f.clone, "show", "HEAD:another.md"); got != "another" {
		t.Fatalf("local merge disappeared after push rejection: %q", got)
	}
}

func TestSyncReportsMissingUpstreamAndFetchFailure(t *testing.T) {
	t.Run("missing upstream", func(t *testing.T) {
		f := newSyncFixture(t)
		syncTestGit(t, f.clone, "branch", "--unset-upstream")
		_, err := runFixtureSync(t, f, false)
		if err == nil || !strings.Contains(err.Error(), "has no usable upstream") {
			t.Fatalf("missing upstream error = %v", err)
		}
	})
	t.Run("fetch failure", func(t *testing.T) {
		f := newSyncFixture(t)
		syncTestGit(t, f.clone, "remote", "set-url", "origin", filepath.Join(f.root, "missing.git"))
		_, err := runFixtureSync(t, f, false)
		if err == nil || !strings.Contains(err.Error(), "fetching felt store upstream failed") {
			t.Fatalf("fetch failure = %v", err)
		}
	})
	t.Run("deleted tracking branch", func(t *testing.T) {
		f := newSyncFixture(t)
		peer := filepath.Join(f.root, "peer")
		syncTestGit(t, f.root, "clone", f.remote, peer)
		syncTestGit(t, peer, "config", "user.name", "Peer")
		syncTestGit(t, peer, "config", "user.email", "peer@example.invalid")
		writeSyncFile(t, peer, "upstream.md", "upstream\n")
		syncTestGit(t, peer, "add", "upstream.md")
		syncTestGit(t, peer, "commit", "-m", "upstream")
		syncTestGit(t, peer, "push")
		syncTestGit(t, f.clone, "fetch", "origin")
		upstream := syncTestGit(t, f.clone, "rev-parse", "@{upstream}")
		branch := syncTestGit(t, f.clone, "symbolic-ref", "--short", "HEAD")
		headBefore := syncTestGit(t, f.clone, "rev-parse", "HEAD")
		syncTestGit(t, f.remote, "update-ref", "-d", "refs/heads/"+branch)

		_, err := runFixtureSync(t, f, false)
		if err == nil || !strings.Contains(err.Error(), "fetching felt store upstream failed") {
			t.Fatalf("deleted tracking branch error = %v", err)
		}
		if got := syncTestGit(t, f.clone, "rev-parse", "HEAD"); got != headBefore {
			t.Fatalf("failed fetch changed HEAD: %s", got)
		}
		if got := syncTestGit(t, f.clone, "rev-parse", "@{upstream}"); got != upstream {
			t.Fatalf("stale upstream ref changed unexpectedly: %s != %s", got, upstream)
		}
	})
}

func TestSyncResolvesSymlinkedStoreAndSerializesRepository(t *testing.T) {
	f := newSyncFixture(t)
	project := filepath.Join(f.root, "project")
	view := filepath.Join(project, ".felt")
	storeView := filepath.Join(f.clone, ".felt", "nested")
	if err := os.MkdirAll(storeView, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(project, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(storeView, view); err != nil {
		t.Fatal(err)
	}
	previousDir := changeDir
	changeDir = project
	t.Cleanup(func() { changeDir = previousDir })
	var output bytes.Buffer
	cmd := &cobra.Command{}
	cmd.SetOut(&output)
	if err := syncCmd.RunE(cmd, nil); err != nil {
		t.Fatal(err)
	}
	common := syncTestGit(t, f.clone, "rev-parse", "--git-common-dir")
	if !filepath.IsAbs(common) {
		common = filepath.Join(f.clone, common)
	}
	unlock, err := lockSyncRepository(common)
	if err != nil {
		t.Fatal(err)
	}
	acquired := make(chan error, 1)
	go func() {
		release, err := lockSyncRepository(common)
		if err == nil {
			release()
		}
		acquired <- err
	}()
	select {
	case err := <-acquired:
		t.Fatalf("second lock acquired before release: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	unlock()
	select {
	case err := <-acquired:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("second lock did not proceed after release")
	}
}

func FuzzSyncStateSequencePreservesLocalFiles(fz *testing.F) {
	fz.Add([]byte{0})
	fz.Add([]byte{1, 2, 0})
	fz.Add([]byte{2, 1, 2, 0})
	fz.Add([]byte{2})
	fz.Add([]byte{3})
	fz.Add([]byte{4})
	fz.Add([]byte{0, 2})
	fz.Add([]byte{2, 3})
	fz.Add([]byte{4, 2})
	fz.Fuzz(func(t *testing.T, operations []byte) {
		if len(operations) > 8 {
			operations = operations[:8]
		}
		f := newSyncFixture(t)
		peer := filepath.Join(f.root, "peer")
		syncTestGit(t, f.root, "clone", f.remote, peer)
		syncTestGit(t, peer, "config", "user.name", "Peer")
		syncTestGit(t, peer, "config", "user.email", "peer@example.invalid")
		staged := false
		conflict := false
		ignoredCollision := false
		for i, op := range operations {
			name := fmt.Sprintf("local-%d.md", i)
			switch op % 5 {
			case 0:
				writeSyncFile(t, f.clone, name, "unstaged\n")
			case 1:
				writeSyncFile(t, f.clone, name, "staged\n")
				syncTestGit(t, f.clone, "add", name)
				staged = true
			case 2:
				upstreamName := "upstream-" + name
				writeSyncFile(t, peer, upstreamName, "upstream\n")
				syncTestGit(t, peer, "add", upstreamName)
				syncTestGit(t, peer, "commit", "-m", "upstream "+name)
				syncTestGit(t, peer, "push")
			case 3:
				writeSyncFile(t, f.clone, "base.md", fmt.Sprintf("local conflict %d\n", i))
				writeSyncFile(t, peer, "base.md", fmt.Sprintf("upstream conflict %d\n", i))
				syncTestGit(t, peer, "add", "base.md")
				syncTestGit(t, peer, "commit", "-m", "upstream conflict "+name)
				syncTestGit(t, peer, "push")
				conflict = true
			case 4:
				ignoredName := "ignored-" + name
				writeSyncFile(t, filepath.Join(f.clone, ".git", "info"), "exclude", "ignored-local-*.md\n")
				writeSyncFile(t, f.clone, ignoredName, "ignored local\n")
				writeSyncFile(t, peer, ignoredName, "upstream tracked\n")
				syncTestGit(t, peer, "add", ignoredName)
				syncTestGit(t, peer, "commit", "-m", "upstream ignored collision "+name)
				syncTestGit(t, peer, "push")
				ignoredCollision = true
			}
		}
		_, err := runFixtureSync(t, f, false)
		if staged {
			if err == nil || !strings.Contains(err.Error(), "staged changes") {
				t.Fatalf("staged state should refuse sync, err = %v", err)
			}
		} else if conflict || ignoredCollision {
			if err == nil {
				t.Fatalf("conflict or ignored collision should refuse sync")
			}
		} else if err != nil {
			t.Fatalf("non-overlapping state should sync safely: %v", err)
		}
		for i, op := range operations {
			if op%5 == 0 {
				name := fmt.Sprintf("local-%d.md", i)
				got, err := os.ReadFile(filepath.Join(f.clone, name))
				if err != nil || string(got) != "unstaged\n" {
					t.Fatalf("local state %s lost: %q %v", name, got, err)
				}
			}
			if op%5 == 4 {
				name := fmt.Sprintf("ignored-local-%d.md", i)
				got, err := os.ReadFile(filepath.Join(f.clone, name))
				if err != nil || string(got) != "ignored local\n" {
					t.Fatalf("ignored local state %s lost: %q %v", name, got, err)
				}
			}
		}
		if err == nil {
			for i, op := range operations {
				if op%5 == 2 {
					name := fmt.Sprintf("upstream-local-%d.md", i)
					if got := syncTestGit(t, f.clone, "show", "HEAD:"+name); got != "upstream" {
						t.Fatalf("incoming peer file %s = %q", name, got)
					}
				}
			}
		}
	})
}
