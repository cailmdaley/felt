package feltcli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
)

func runFFOnlyJSON(t *testing.T, storeDir string) syncFFReport {
	t.Helper()
	env, streams := testEnv(t)
	a := testApp(t, env)
	a.dir = storeDir
	a.json = true
	cmd := a.syncCmd()
	cmd.SetArgs([]string{"--ff-only"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("felt sync --ff-only --json failed: %v\nstdout: %s", err, streams.Stdout.String())
	}
	var report syncFFReport
	if err := json.Unmarshal([]byte(streams.Stdout.String()), &report); err != nil {
		t.Fatalf("unmarshal syncFFReport: %v\nraw: %s", err, streams.Stdout.String())
	}
	return report
}

func initFeltDir(t *testing.T, f syncFixture) {
	t.Helper()
	writeSyncFile(t, f.peer, felt.DirName+"/note.md", "# initial\n")
	syncTestGit(t, f.peer, "add", felt.DirName+"/note.md")
	syncTestGit(t, f.peer, "commit", "-m", "init felt")
	syncTestGit(t, f.peer, "push")
	syncTestGit(t, f.clone, "pull", "--ff-only")
}

func TestSyncFFOnlyCleanAndUpToDate(t *testing.T) {
	t.Parallel()
	f := newSyncFixture(t)
	initFeltDir(t, f)

	prevShort := syncTestGit(t, f.clone, "rev-parse", "--short", "HEAD")
	writeSyncFile(t, f.peer, felt.DirName+"/note.md", "# updated\n")
	syncTestGit(t, f.peer, "add", felt.DirName+"/note.md")
	syncTestGit(t, f.peer, "commit", "-m", "upstream update")
	syncTestGit(t, f.peer, "push")
	upstreamHead := syncTestGit(t, f.peer, "rev-parse", "HEAD")

	report := runFFOnlyJSON(t, f.clone)
	if len(report.Repos) != 1 {
		t.Fatalf("repos = %+v, want 1", report.Repos)
	}
	r := report.Repos[0]
	if r.Status != "fast_forwarded" || r.PreviousSHA != prevShort || r.Commits != 1 || r.SyncedAt == "" {
		t.Fatalf("unexpected repo result: %+v", r)
	}
	if got := syncTestGit(t, f.clone, "rev-parse", "HEAD"); got != upstreamHead {
		t.Fatalf("HEAD = %s, want %s", got, upstreamHead)
	}

	report2 := runFFOnlyJSON(t, f.clone)
	if len(report2.Repos) != 1 || report2.Repos[0].Status != "up_to_date" {
		t.Fatalf("second pass = %+v, want up_to_date", report2.Repos)
	}
}

func TestSyncFFOnlyDirtyTrackedAndUntracked(t *testing.T) {
	t.Parallel()
	t.Run("modified tracked file", func(t *testing.T) {
		t.Parallel()
		f := newSyncFixture(t)
		initFeltDir(t, f)
		localHead := syncTestGit(t, f.clone, "rev-parse", "HEAD")

		writeSyncFile(t, f.peer, felt.DirName+"/other.md", "# other\n")
		syncTestGit(t, f.peer, "add", felt.DirName+"/other.md")
		syncTestGit(t, f.peer, "commit", "-m", "upstream other")
		syncTestGit(t, f.peer, "push")

		localBytes := "# local uncommitted edit\n"
		writeSyncFile(t, f.clone, felt.DirName+"/note.md", localBytes)

		report := runFFOnlyJSON(t, f.clone)
		if len(report.Repos) != 1 {
			t.Fatalf("repos = %+v", report.Repos)
		}
		r := report.Repos[0]
		if r.Status != "stale_dirty" || r.Behind == nil || *r.Behind != 1 || !strings.Contains(r.Reason, "uncommitted") {
			t.Fatalf("dirty tracked result = %+v", r)
		}
		if got := syncTestGit(t, f.clone, "rev-parse", "HEAD"); got != localHead {
			t.Fatalf("HEAD moved: %s != %s", got, localHead)
		}
		data, err := os.ReadFile(filepath.Join(f.clone, felt.DirName, "note.md"))
		if err != nil || string(data) != localBytes {
			t.Fatalf("local bytes altered: %q (%v)", data, err)
		}
	})

	t.Run("untracked file", func(t *testing.T) {
		t.Parallel()
		f := newSyncFixture(t)
		initFeltDir(t, f)
		localHead := syncTestGit(t, f.clone, "rev-parse", "HEAD")

		writeSyncFile(t, f.peer, felt.DirName+"/other.md", "# other\n")
		syncTestGit(t, f.peer, "add", felt.DirName+"/other.md")
		syncTestGit(t, f.peer, "commit", "-m", "upstream other")
		syncTestGit(t, f.peer, "push")

		untrackedBytes := "# untracked draft\n"
		writeSyncFile(t, f.clone, felt.DirName+"/draft.md", untrackedBytes)

		report := runFFOnlyJSON(t, f.clone)
		if len(report.Repos) != 1 {
			t.Fatalf("repos = %+v", report.Repos)
		}
		r := report.Repos[0]
		if r.Status != "stale_dirty" || r.Behind == nil || *r.Behind != 1 {
			t.Fatalf("dirty untracked result = %+v", r)
		}
		if got := syncTestGit(t, f.clone, "rev-parse", "HEAD"); got != localHead {
			t.Fatalf("HEAD moved: %s != %s", got, localHead)
		}
		data, err := os.ReadFile(filepath.Join(f.clone, felt.DirName, "draft.md"))
		if err != nil || string(data) != untrackedBytes {
			t.Fatalf("untracked bytes altered: %q (%v)", data, err)
		}
	})
}

func TestSyncFFOnlyDivergedAndAhead(t *testing.T) {
	t.Parallel()
	t.Run("diverged", func(t *testing.T) {
		t.Parallel()
		f := newSyncFixture(t)
		initFeltDir(t, f)

		writeSyncFile(t, f.peer, felt.DirName+"/remote.md", "# remote\n")
		syncTestGit(t, f.peer, "add", felt.DirName+"/remote.md")
		syncTestGit(t, f.peer, "commit", "-m", "remote")
		syncTestGit(t, f.peer, "push")

		writeSyncFile(t, f.clone, felt.DirName+"/local.md", "# local\n")
		syncTestGit(t, f.clone, "add", felt.DirName+"/local.md")
		syncTestGit(t, f.clone, "commit", "-m", "local")
		localHead := syncTestGit(t, f.clone, "rev-parse", "HEAD")

		report := runFFOnlyJSON(t, f.clone)
		if len(report.Repos) != 1 {
			t.Fatalf("repos = %+v", report.Repos)
		}
		r := report.Repos[0]
		if r.Status != "stale_diverged" || r.Ahead == nil || *r.Ahead != 1 || r.Behind == nil || *r.Behind != 1 {
			t.Fatalf("diverged result = %+v", r)
		}
		if got := syncTestGit(t, f.clone, "rev-parse", "HEAD"); got != localHead {
			t.Fatalf("HEAD moved: %s != %s", got, localHead)
		}
	})

	t.Run("ahead only", func(t *testing.T) {
		t.Parallel()
		f := newSyncFixture(t)
		initFeltDir(t, f)

		writeSyncFile(t, f.clone, felt.DirName+"/local.md", "# local\n")
		syncTestGit(t, f.clone, "add", felt.DirName+"/local.md")
		syncTestGit(t, f.clone, "commit", "-m", "local")
		localHead := syncTestGit(t, f.clone, "rev-parse", "HEAD")

		report := runFFOnlyJSON(t, f.clone)
		if len(report.Repos) != 1 {
			t.Fatalf("repos = %+v", report.Repos)
		}
		r := report.Repos[0]
		if r.Status != "ahead" || r.Ahead == nil || *r.Ahead != 1 || r.Behind == nil || *r.Behind != 0 {
			t.Fatalf("ahead result = %+v", r)
		}
		if got := syncTestGit(t, f.clone, "rev-parse", "HEAD"); got != localHead {
			t.Fatalf("HEAD moved: %s != %s", got, localHead)
		}
	})
}

func TestSyncFFOnlyMountedSymlinkRepo(t *testing.T) {
	t.Parallel()
	loom := newSyncFixture(t)
	pando := newSyncFixture(t)
	initFeltDir(t, loom)
	initFeltDir(t, pando)

	if err := os.Symlink(filepath.Join(pando.clone, felt.DirName), filepath.Join(loom.clone, felt.DirName, "pando")); err != nil {
		t.Fatal(err)
	}
	writeSyncFile(t, loom.clone, ".gitignore", ".felt/pando\n")
	syncTestGit(t, loom.clone, "add", ".gitignore")
	syncTestGit(t, loom.clone, "commit", "-m", "ignore mounted pando")
	syncTestGit(t, loom.clone, "push")
	syncTestGit(t, loom.peer, "pull", "--ff-only")

	writeSyncFile(t, loom.peer, felt.DirName+"/loom-new.md", "# loom\n")
	syncTestGit(t, loom.peer, "add", felt.DirName+"/loom-new.md")
	syncTestGit(t, loom.peer, "commit", "-m", "loom update")
	syncTestGit(t, loom.peer, "push")
	loomHead := syncTestGit(t, loom.peer, "rev-parse", "HEAD")

	writeSyncFile(t, pando.peer, felt.DirName+"/pando-new.md", "# pando\n")
	syncTestGit(t, pando.peer, "add", felt.DirName+"/pando-new.md")
	syncTestGit(t, pando.peer, "commit", "-m", "pando update")
	syncTestGit(t, pando.peer, "push")
	pandoHead := syncTestGit(t, pando.peer, "rev-parse", "HEAD")

	report := runFFOnlyJSON(t, loom.clone)
	if len(report.Repos) != 2 {
		t.Fatalf("repos = %+v, want 2", report.Repos)
	}
	for _, r := range report.Repos {
		if r.Status != "fast_forwarded" {
			t.Fatalf("repo %s status = %s, want fast_forwarded", r.Path, r.Status)
		}
	}
	if got := syncTestGit(t, loom.clone, "rev-parse", "HEAD"); got != loomHead {
		t.Fatalf("loom HEAD = %s, want %s", got, loomHead)
	}
	if got := syncTestGit(t, pando.clone, "rev-parse", "HEAD"); got != pandoHead {
		t.Fatalf("pando HEAD = %s, want %s", got, pandoHead)
	}
}

func TestSyncFFOnlyFetchFailureDetachedAndFlags(t *testing.T) {
	t.Parallel()
	t.Run("fetch failure", func(t *testing.T) {
		t.Parallel()
		f := newSyncFixture(t)
		initFeltDir(t, f)
		syncTestGit(t, f.clone, "remote", "set-url", "origin", filepath.Join(t.TempDir(), "missing.git"))

		report := runFFOnlyJSON(t, f.clone)
		if len(report.Repos) != 1 || report.Repos[0].Status != "fetch_failed" || report.Repos[0].Reason == "" {
			t.Fatalf("fetch failure result = %+v", report.Repos)
		}
	})

	t.Run("detached HEAD", func(t *testing.T) {
		t.Parallel()
		f := newSyncFixture(t)
		initFeltDir(t, f)
		head := syncTestGit(t, f.clone, "rev-parse", "HEAD")
		syncTestGit(t, f.clone, "checkout", "--detach", head)

		report := runFFOnlyJSON(t, f.clone)
		if len(report.Repos) != 1 || report.Repos[0].Status != "no_upstream" {
			t.Fatalf("detached result = %+v", report.Repos)
		}
	})

	t.Run("rejects --push with --ff-only", func(t *testing.T) {
		t.Parallel()
		f := newSyncFixture(t)
		initFeltDir(t, f)
		env, _ := testEnv(t)
		a := testApp(t, env)
		a.dir = f.clone
		cmd := a.syncCmd()
		cmd.SetArgs([]string{"--ff-only", "--push"})
		if err := cmd.Execute(); err == nil || !strings.Contains(err.Error(), "cannot be combined") {
			t.Fatalf("err = %v, want mutual exclusion error", err)
		}
	})
}

func TestSyncFFOnlyHonorsFeltSyncLock(t *testing.T) {
	t.Parallel()
	f := newSyncFixture(t)
	initFeltDir(t, f)

	lockPath := filepath.Join(f.clone, ".git", "felt-sync.lock")
	lockFile, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer lockFile.Close()
	if err := syscall.Flock(int(lockFile.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}

	done := make(chan syncFFReport, 1)
	go func() {
		env, _ := testEnv(t)
		var out bytes.Buffer
		env.Stdout = &out
		done <- testApp(t, env).syncStoreAndMountsFFOnly(t.Context(), filepath.Join(f.clone, felt.DirName), syncGitTimeout)
	}()

	select {
	case r := <-done:
		t.Fatalf("syncStoreAndMountsFFOnly finished while felt-sync.lock was held: %+v", r)
	case <-time.After(150 * time.Millisecond):
	}

	if err := syscall.Flock(int(lockFile.Fd()), syscall.LOCK_UN); err != nil {
		t.Fatal(err)
	}
	select {
	case r := <-done:
		if len(r.Repos) != 1 || r.Repos[0].Status != "up_to_date" {
			t.Fatalf("after unlock result = %+v", r)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("syncStoreAndMountsFFOnly did not complete after lock release")
	}
}
