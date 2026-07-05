package felt

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// F4 — cross-process mutual exclusion for a fiber's read-modify-write cycle.
//
// This serializes the Go CLI write verbs that mutate a fiber — both a direct
// `felt <verb>` invocation and one the daemon shells as a subprocess. Every
// such verb follows the same shape: read the current file, mutate the
// in-memory Felt, write it back. Two processes doing this concurrently on the
// SAME fiber — e.g. a worker's `felt shuttle handoff` stamping handed_off_at at
// the same instant the daemon shells `felt shuttle mark-runtime` to stamp
// dispatched_at — race: whichever writes last wins, and the other's read
// (already stale) silently clobbers it on write. Rare (needs true simultaneity)
// but real for shared fibers, and silent — nothing errors, a field just
// reverts.
//
// Scope: this lock covers Go CLI writers only. The daemon's OWN in-process
// Elixir document writers — LifecycleStore resume_from_doc / mark_awaiting via
// FiberDoc.write! — do NOT take this flock; they write inside the daemon
// process and are outside this cross-process guard. In practice they run
// sequentially within the daemon rather than being concurrently excluded, so
// they don't race each other; the flock's job is to keep the CLI writers above
// from racing anyone (including a daemon-shelled CLI subprocess).
//
// LockFiberFile/Storage.LockFiber close that window: acquire the lock, THEN
// read (so the read is guaranteed fresh, not raced against a writer that
// finishes between an earlier unlocked read and lock acquisition), mutate,
// write, release. It lives here — not special-cased into any one verb — so
// every read-modify-write call site gets it by construction.

// lockSuffix names a fiber's advisory-lock sidecar file: "<mdPath>.lock". It is
// never a fiber itself (felt only reads/globs "*.md"), so it is completely
// inert to every other code path — reads, `felt ls`, the FTS index walk, git —
// and never needs cleanup beyond the directory itself.
const lockSuffix = ".lock"

// fiberLockTimeout bounds how long LockFiberFile waits for a contended lock
// before failing loud. A read-modify-write cycle is a handful of small file
// operations — a few seconds is generous headroom for another process to
// finish its own cycle. Waiting longer would mean the CLI (a human command, or
// a daemon-shelled subprocess already under the daemon's own Runner timeout)
// hangs instead of surfacing genuine contention or a wedged holder.
const fiberLockTimeout = 5 * time.Second

// lockPollInterval is the spacing between non-blocking lock attempts.
const lockPollInterval = 25 * time.Millisecond

// LockFiberFile acquires an exclusive advisory lock scoped to the fiber file at
// mdPath, returning an unlock func to release it. The caller is expected to
// read (or re-read) the fiber only AFTER acquiring the lock, and to hold it
// through the write — that ordering is what makes the read-modify-write cycle
// atomic across processes; the lock alone does nothing if a caller reads before
// locking and mutates that stale copy.
//
// Uses syscall.Flock (portable across macOS and Linux, unlike fcntl byte-range
// locks) against a ".lock" sidecar next to mdPath, polled non-blockingly rather
// than via a blocking Flock call, so a wedged holder produces a bounded, loud
// timeout (fiberLockTimeout) instead of hanging the caller forever.
//
// Resolves mdPath through symlinks before deriving the lock path, because loom
// is one physical store reached via different symlinked paths: the daemon may
// address a fiber via ~/loom/.felt/<project>/... while a worker's
// SHUTTLE_FIBER_PATH goes via ~/project/.felt/... (a symlink into loom). Those
// are different strings that name the SAME file — locking on the raw string
// would give each caller its own, unrelated ".lock" sidecar and never
// serialize them, silently reopening exactly the handoff-vs-mark-runtime race
// this lock exists to close. EvalSymlinks needs the target to exist; a
// brand-new fiber's directory usually already does (installed before any
// runtime write), so resolving the parent directory and rejoining the leaf
// name covers that case too. Falls back to the unresolved path only if BOTH
// resolutions fail (e.g. the directory doesn't exist yet either) — locking on
// an unresolved path is still correct for a same-process/same-path caller, it
// just loses cross-symlink serialization.
func LockFiberFile(mdPath string) (unlock func() error, err error) {
	lockPath := resolveLockTarget(mdPath) + lockSuffix
	if err := os.MkdirAll(filepath.Dir(lockPath), 0755); err != nil {
		return nil, fmt.Errorf("creating directory for lock %s: %w", lockPath, err)
	}
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		return nil, fmt.Errorf("opening lock file %s: %w", lockPath, err)
	}

	deadline := time.Now().Add(fiberLockTimeout)
	for {
		flockErr := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if flockErr == nil {
			break
		}
		if !errors.Is(flockErr, syscall.EWOULDBLOCK) {
			f.Close()
			return nil, fmt.Errorf("locking %s: %w", lockPath, flockErr)
		}
		if time.Now().After(deadline) {
			f.Close()
			return nil, fmt.Errorf(
				"timed out after %s waiting for the lock on %s — another process is writing this fiber",
				fiberLockTimeout, mdPath)
		}
		time.Sleep(lockPollInterval)
	}

	// The lock file is deliberately NEVER unlinked (here or anywhere else) —
	// only unlocked and closed. Deleting it on release is the classic
	// unlink-then-race hazard: if this process removes the path while another
	// process already has the SAME inode open (waiting on Flock, or about to
	// call it), a third process opening the path afterward creates a brand-new
	// inode and locks THAT one — two processes now hold "the lock" on two
	// different inodes, sharing nothing, mutual exclusion silently defeated.
	// Leaving the sidecar in place forever means every locker always opens and
	// flocks the same inode. The only downside is the sidecar existing as an
	// untracked file in a git-synced store, which ensureGitignoreCoversLocks
	// (in Storage.LockFiber) and the updated defaultGitignore handle.
	released := false
	return func() error {
		if released {
			return nil
		}
		released = true
		defer f.Close()
		return syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	}, nil
}

// resolveLockTarget returns the canonical, symlink-resolved form of mdPath so
// two different symlinked routes to the same physical file derive the same
// lock path. Tries the full path first (works once the fiber file exists),
// then falls back to resolving just the parent directory (covers a fiber
// being written for the first time, whose directory predates it but whose file
// doesn't exist yet), then gives up and returns mdPath unresolved.
func resolveLockTarget(mdPath string) string {
	if resolved, err := filepath.EvalSymlinks(mdPath); err == nil {
		return resolved
	}
	dir := filepath.Dir(mdPath)
	if resolvedDir, err := filepath.EvalSymlinks(dir); err == nil {
		return filepath.Join(resolvedDir, filepath.Base(mdPath))
	}
	return mdPath
}

// LockFiber acquires the advisory lock for id's on-disk fiber file — see
// LockFiberFile. Storage-aware convenience so callers that already have a
// *Storage don't need to compute the path themselves.
//
// Also best-effort ensures the store's felt-generated .gitignore covers the
// ".md.lock" sidecars this creates (see ensureGitignoreCoversLocks) — a store
// initialized before F4 would otherwise accumulate them as untracked litter on
// every locked write, since Storage.Init only writes .gitignore when one is
// entirely absent.
func (s *Storage) LockFiber(id string) (unlock func() error, err error) {
	ensureGitignoreCoversLocks(s.root)
	return LockFiberFile(s.Path(id))
}

// lockGitignoreLine is the pattern added to a felt-generated .gitignore so the
// per-fiber ".lock" sidecars LockFiberFile creates never show up as untracked
// files in a git-synced store. Locks are deliberately never unlinked on
// release (see the unlink-on-release race noted on LockFiberFile's unlock
// closure — removing the file while another process holds/awaits a handle to
// the same inode can let a third process re-create and lock a *different*
// inode at the same path, defeating mutual exclusion), so gitignore is the
// answer to the litter, not cleanup.
const lockGitignoreLine = "*.md.lock"

// feltGitignoreHeader marks a .gitignore as felt's own generated file (see
// defaultGitignore) — the only kind ensureGitignoreCoversLocks will ever
// modify. A hand-authored .gitignore is left untouched.
const feltGitignoreHeader = "# Generated by felt"

// ensureGitignoreCoversLocks appends lockGitignoreLine to the store's
// .gitignore if it is felt-generated and doesn't already have it. Best-effort:
// a store with no .gitignore yet, an unreadable one, or a hand-authored one is
// left alone (Storage.Init handles the fresh-store case via the updated
// defaultGitignore; this only backfills existing stores created before F4).
// Errors are swallowed — failing to tidy .gitignore must never block the lock
// acquisition it's called from.
func ensureGitignoreCoversLocks(root string) {
	path := filepath.Join(root, GitignoreName)
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	content := string(data)
	if !strings.HasPrefix(content, feltGitignoreHeader) {
		return
	}
	for _, line := range strings.Split(content, "\n") {
		if strings.TrimSpace(line) == lockGitignoreLine {
			return
		}
	}
	if !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	content += lockGitignoreLine + "\n"
	_ = os.WriteFile(path, []byte(content), 0644)
}
