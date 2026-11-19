package feltcli

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSyncNetworkTimeoutDoesNotApplyToLocalMerge(t *testing.T) {
	t.Parallel()
	env, _ := testEnv(t)
	lock := filepath.Join(t.TempDir(), "index.lock")
	env.Set("SYNC_INDEX_LOCK", lock)
	fakeCommand(t, env, "git", `#!/bin/sh
case "$4" in
 fetch) exec sleep 30 ;;
 merge)
   : > "$SYNC_INDEX_LOCK"
   sleep 0.05
   rm "$SYNC_INDEX_LOCK"
   printf 'merge completed\n'
   ;;
esac
`)
	a := testApp(t, env)
	if _, err := a.runSyncGit(context.Background(), t.TempDir(), time.Millisecond, "fetch", "origin"); err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("fetch error: %v", err)
	}
	// A cancelled caller cannot kill a merge between acquiring and releasing its
	// index lock. Merge also outlasts the fetch budget by a wide margin.
	parent, cancel := context.WithCancel(context.Background())
	cancel()
	out, err := a.runSyncGit(parent, t.TempDir(), 0, "merge", "FETCH_HEAD")
	if err != nil || !strings.Contains(out, "merge completed") {
		t.Fatalf("merge: %q, %v", out, err)
	}
	if _, err := os.Stat(lock); !os.IsNotExist(err) {
		t.Fatalf("merge did not release index.lock: %v", err)
	}
}

func TestSyncFetchTimeoutLeavesHeadUntouched(t *testing.T) {
	t.Parallel()
	f := newSyncFixture(t)
	before := syncTestGit(t, f.clone, "rev-parse", "HEAD")
	env, _ := testEnv(t)
	err := testApp(t, env).syncStore(context.Background(), f.clone, false, time.Nanosecond, env.Stdout)
	if err == nil || !strings.Contains(err.Error(), "fetching felt store upstream failed") || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("sync error: %v", err)
	}
	if after := syncTestGit(t, f.clone, "rev-parse", "HEAD"); after != before {
		t.Fatalf("failed fetch changed HEAD from %s to %s", before, after)
	}
	if _, err := os.Stat(filepath.Join(f.clone, ".git", "index.lock")); !os.IsNotExist(err) {
		t.Fatalf("failed fetch left index lock: %v", err)
	}
}
