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

// LockFiberFile provides cross-process mutual exclusion for a fiber's
// read-modify-write cycle. Two writers that both read the same file before
// either writes can otherwise race: whichever writes last silently discards
// fields changed by the other.
//
// The lock serializes callers that use this API. A caller acquires it before
// reading, then holds it through the write, so its in-memory copy cannot become
// stale between those operations. Writers outside this package must coordinate
// their own document updates.

// lockSuffix names a fiber's advisory-lock sidecar file: "<mdPath>.lock". It is
// never a fiber itself (felt only reads/globs "*.md"), so it is completely
// inert to every other code path — reads, `felt ls`, the relationship walk, git —
// and never needs cleanup beyond the directory itself.
const lockSuffix = ".lock"

// fiberLockTimeout bounds how long LockFiberFile waits for a contended lock
// before failing loud. A read-modify-write cycle is a handful of small file
// operations — a few seconds is generous headroom for another process to
// finish its own cycle. Waiting longer would make a command-line caller or
// subprocess hang instead of surfacing contention or a wedged holder.
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
// Resolves mdPath through symlinks before deriving the lock path, because one
// physical store can be reached through different symlinked paths. Those are
// different strings that name the same file — locking on the raw string would
// give each caller its own, unrelated ".lock" sidecar and fail to serialize
// them. EvalSymlinks needs the target to exist; a
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
	// untracked file in a git-synced store, which defaultGitignore and
	// ensureGitignoreCoversSupportFiles (in Storage.LockFiber) handle.
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
// ".md.lock" sidecars this creates and the atomic writer's temp files (see
// ensureGitignoreCoversSupportFiles) — a store whose .gitignore predates
// either line would otherwise accumulate them as untracked litter, since
// Storage.Init only writes .gitignore when one is entirely absent.
func (s *Storage) LockFiber(id string) (unlock func() error, err error) {
	ensureGitignoreCoversSupportFiles(s.root)
	return LockFiberFile(s.Path(id))
}

// requiredGitignoreLines are the patterns every felt-generated store
// .gitignore carries (defaultGitignore writes them all):
//
//   - "*.md.lock": the per-fiber lock sidecars LockFiberFile creates. Locks are
//     deliberately never unlinked on release (see the unlink-on-release race
//     noted on LockFiberFile's unlock closure — removing the file while another
//     process holds/awaits a handle to the same inode can let a third process
//     re-create and lock a *different* inode at the same path, defeating mutual
//     exclusion), so gitignore is the answer to the litter, not cleanup.
//   - ".*.tmp": the hidden temp files internal/atomicfile renames into place,
//     visible to git only while a write is in flight or after a crash.
var requiredGitignoreLines = []string{"*.md.lock", ".*.tmp"}

// feltGitignoreHeader marks a .gitignore as felt's own generated file (see
// defaultGitignore) — the only kind ensureGitignoreCoversSupportFiles will
// ever modify. A hand-authored .gitignore is left untouched.
const feltGitignoreHeader = "# Generated by felt"

// ensureGitignoreCoversSupportFiles appends each of requiredGitignoreLines the
// store's felt-generated .gitignore lacks. Best-effort: a store with no
// .gitignore yet, an unreadable one, or a hand-authored one is left alone
// (Storage.Init writes defaultGitignore for a fresh store; this backfills a
// generated file written before a line joined the list). Errors are swallowed
// — failing to tidy .gitignore must never block the lock acquisition it's
// called from.
func ensureGitignoreCoversSupportFiles(root string) {
	path := filepath.Join(root, GitignoreName)
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	content := string(data)
	if !strings.HasPrefix(content, feltGitignoreHeader) {
		return
	}
	present := map[string]bool{}
	for _, line := range strings.Split(content, "\n") {
		present[strings.TrimSpace(line)] = true
	}
	var missing []string
	for _, line := range requiredGitignoreLines {
		if !present[line] {
			missing = append(missing, line)
		}
	}
	if len(missing) == 0 {
		return
	}
	if !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	content += strings.Join(missing, "\n") + "\n"
	_ = os.WriteFile(path, []byte(content), 0644)
}
