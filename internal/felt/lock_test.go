package felt

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestLockFiberFile_MutualExclusion proves the primitive itself: concurrent
// goroutines (distinct file descriptions, same as distinct processes for
// flock's purposes) contending for the same fiber's lock never run their
// critical section simultaneously.
func TestLockFiberFile_MutualExclusion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "f.md")

	var active, maxActive int32
	var wg sync.WaitGroup
	const n = 8
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			unlock, err := LockFiberFile(path)
			if err != nil {
				t.Errorf("LockFiberFile: %v", err)
				return
			}
			cur := atomic.AddInt32(&active, 1)
			for {
				old := atomic.LoadInt32(&maxActive)
				if cur <= old || atomic.CompareAndSwapInt32(&maxActive, old, cur) {
					break
				}
			}
			time.Sleep(5 * time.Millisecond)
			atomic.AddInt32(&active, -1)
			if err := unlock(); err != nil {
				t.Errorf("unlock: %v", err)
			}
		}()
	}
	wg.Wait()

	if got := atomic.LoadInt32(&maxActive); got != 1 {
		t.Fatalf("lock did not exclude: max concurrent holders = %d, want 1", got)
	}
}

// TestStorage_LockFiber_GuardsConcurrentRMW is the F4 keystone: two concurrent
// read-modify-write cycles on the SAME fiber — one bumping counters.a, the
// other counters.b, each for a run of iterations — must each preserve the
// other's field, exactly the "two daemon-shelled writes race the same fiber"
// scenario (a worker's handoff vs a daemon's mark-runtime). Without the lock
// this is racy: last-writer-wins silently drops whichever field the losing
// read was stale on. With the lock (acquire -> read -> mutate -> write ->
// release) it must be exact every time.
func TestStorage_LockFiber_GuardsConcurrentRMW(t *testing.T) {
	dir := t.TempDir()
	st := NewStorage(dir)
	if err := st.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}

	seed := &Felt{ID: "f", Name: "f", Status: StatusOpen}
	if err := seed.SetExtraField("counters", map[string]any{"a": 0, "b": 0}); err != nil {
		t.Fatalf("seed SetExtraField: %v", err)
	}
	if err := st.Write(seed); err != nil {
		t.Fatalf("seed Write: %v", err)
	}

	const iterations = 25
	bump := func(t *testing.T, key string) {
		for i := 0; i < iterations; i++ {
			unlock, err := st.LockFiber("f")
			if err != nil {
				t.Errorf("LockFiber: %v", err)
				return
			}
			cur, err := st.Read("f")
			if err != nil {
				unlock()
				t.Errorf("Read: %v", err)
				return
			}
			var counters map[string]any
			if err := cur.ExtraFields["counters"].Decode(&counters); err != nil {
				unlock()
				t.Errorf("decoding counters: %v", err)
				return
			}
			n, _ := counters[key].(int)
			counters[key] = n + 1
			if err := cur.SetExtraField("counters", counters); err != nil {
				unlock()
				t.Errorf("SetExtraField: %v", err)
				return
			}
			if err := st.Write(cur); err != nil {
				unlock()
				t.Errorf("Write: %v", err)
				return
			}
			if err := unlock(); err != nil {
				t.Errorf("unlock: %v", err)
				return
			}
		}
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); bump(t, "a") }()
	go func() { defer wg.Done(); bump(t, "b") }()
	wg.Wait()

	final, err := st.Read("f")
	if err != nil {
		t.Fatalf("final Read: %v", err)
	}
	var counters map[string]any
	if err := final.ExtraFields["counters"].Decode(&counters); err != nil {
		t.Fatalf("decoding final counters: %v", err)
	}
	a, _ := counters["a"].(int)
	b, _ := counters["b"].(int)
	if a != iterations || b != iterations {
		t.Fatalf("lost updates under concurrent RMW: counters = {a: %d, b: %d}, want {a: %d, b: %d}",
			a, b, iterations, iterations)
	}
}

// TestLockFiberFile_ResolvesSymlinkedPaths is the symlink-identity fix: loom is
// one physical store reached via different symlinked paths (the daemon via
// ~/loom/.felt/<project>/..., a worker's SHUTTLE_FIBER_PATH via
// ~/project/.felt/..., a symlink into loom). Two lockers naming the SAME
// physical fiber via different path strings — one through the real directory,
// one through a symlinked one — must still contend on a single lock. Without
// resolving symlinks first, they'd derive two unrelated ".lock" sidecars and
// never serialize, silently reopening the exact handoff-vs-mark-runtime race
// this lock exists to close.
func TestLockFiberFile_ResolvesSymlinkedPaths(t *testing.T) {
	realDir := t.TempDir()
	realPath := filepath.Join(realDir, "f.md")
	if err := os.WriteFile(realPath, []byte("x"), 0644); err != nil {
		t.Fatalf("seeding fiber file: %v", err)
	}

	linkParent := t.TempDir()
	linkDir := filepath.Join(linkParent, "linked")
	if err := os.Symlink(realDir, linkDir); err != nil {
		t.Fatalf("symlinking directory: %v", err)
	}
	linkedPath := filepath.Join(linkDir, "f.md")

	var active, maxActive int32
	var wg sync.WaitGroup
	contend := func(path string) {
		defer wg.Done()
		for i := 0; i < 10; i++ {
			unlock, err := LockFiberFile(path)
			if err != nil {
				t.Errorf("LockFiberFile(%s): %v", path, err)
				return
			}
			cur := atomic.AddInt32(&active, 1)
			for {
				old := atomic.LoadInt32(&maxActive)
				if cur <= old || atomic.CompareAndSwapInt32(&maxActive, old, cur) {
					break
				}
			}
			time.Sleep(2 * time.Millisecond)
			atomic.AddInt32(&active, -1)
			if err := unlock(); err != nil {
				t.Errorf("unlock: %v", err)
			}
		}
	}
	wg.Add(2)
	go contend(realPath)
	go contend(linkedPath)
	wg.Wait()

	if got := atomic.LoadInt32(&maxActive); got != 1 {
		t.Fatalf("locking via the real path and a symlinked path to the same fiber did not serialize: "+
			"max concurrent holders = %d, want 1", got)
	}
}

// TestEnsureGitignoreCoversLocks_AppendsToExistingGeneratedFile is the
// gitignore-litter fix: an older store has a felt-generated .gitignore missing
// the "*.md.lock" line (Storage.Init only writes .gitignore when one is
// entirely absent, so such a store never self-heals on its own).
// Storage.LockFiber must backfill that line so lock sidecars don't accumulate
// as untracked files.
func TestEnsureGitignoreCoversLocks_AppendsToExistingGeneratedFile(t *testing.T) {
	dir := t.TempDir()
	st := NewStorage(dir)
	if err := os.MkdirAll(st.root, 0755); err != nil {
		t.Fatalf("creating .felt dir: %v", err)
	}
	older := "# Generated by felt — older store, regenerate from fibers\nsome-legacy-artifact\n"
	gitignorePath := filepath.Join(st.root, GitignoreName)
	if err := os.WriteFile(gitignorePath, []byte(older), 0644); err != nil {
		t.Fatalf("seeding older .gitignore: %v", err)
	}

	seed := &Felt{ID: "f", Name: "f", Status: StatusOpen}
	if err := st.Write(seed); err != nil {
		t.Fatalf("Write: %v", err)
	}
	unlock, err := st.LockFiber("f")
	if err != nil {
		t.Fatalf("LockFiber: %v", err)
	}
	defer unlock()

	data, err := os.ReadFile(gitignorePath)
	if err != nil {
		t.Fatalf("reading .gitignore: %v", err)
	}
	if !strings.Contains(string(data), lockGitignoreLine) {
		t.Fatalf(".gitignore was not backfilled with %q:\n%s", lockGitignoreLine, data)
	}
	if !strings.Contains(string(data), "some-legacy-artifact") {
		t.Fatalf("backfill must preserve existing lines:\n%s", data)
	}
}

// TestEnsureGitignoreCoversLocks_LeavesHandAuthoredFileAlone proves the
// header-check guard: a .gitignore that isn't felt-generated (no "# Generated
// by felt" header) is never modified, even if a lock is acquired in that store.
func TestEnsureGitignoreCoversLocks_LeavesHandAuthoredFileAlone(t *testing.T) {
	dir := t.TempDir()
	st := NewStorage(dir)
	if err := os.MkdirAll(st.root, 0755); err != nil {
		t.Fatalf("creating .felt dir: %v", err)
	}
	handAuthored := "# my own gitignore\nsecrets.txt\n"
	gitignorePath := filepath.Join(st.root, GitignoreName)
	if err := os.WriteFile(gitignorePath, []byte(handAuthored), 0644); err != nil {
		t.Fatalf("seeding hand-authored .gitignore: %v", err)
	}

	seed := &Felt{ID: "f", Name: "f", Status: StatusOpen}
	if err := st.Write(seed); err != nil {
		t.Fatalf("Write: %v", err)
	}
	unlock, err := st.LockFiber("f")
	if err != nil {
		t.Fatalf("LockFiber: %v", err)
	}
	defer unlock()

	data, err := os.ReadFile(gitignorePath)
	if err != nil {
		t.Fatalf("reading .gitignore: %v", err)
	}
	if string(data) != handAuthored {
		t.Fatalf("hand-authored .gitignore was modified:\ngot:  %q\nwant: %q", data, handAuthored)
	}
}
