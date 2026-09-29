// Package atomicfile replaces files so that a concurrent reader sees either
// the old content or the new, never a truncated or half-written file.
//
// A replacement is written to a temp file in the target's own directory (a
// rename is atomic only within one filesystem), under a hidden name ending in
// .tmp that felt's store walkers never read as a fiber, given the intended
// mode (os.CreateTemp makes it 0600), and renamed over the target.
//
// Two strengths, chosen by the caller:
//
//   - Write and Create are durable. The temp file is fsynced before the
//     rename and the parent directory after it, so the new content survives
//     power loss wherever the filesystem honours those syncs. They serve the
//     small operator, config and receipt files that exist on one machine only
//     (host.json, remotes.json, the dedup receipt, the mailbox, the plugin
//     marker and journal, the transcript cache).
//   - WriteUnsynced is atomic but not durable: no file or directory fsync. It
//     serves fiber files, which are git-tracked (a crash loses at most what
//     git can restore) and are rewritten in bulk by migrations, identity
//     backfill and subtree moves. On macOS each fsync is an F_FULLFSYNC
//     costing milliseconds, so a durable rewrite of a store of thousands of
//     fibers takes minutes where an unsynced one takes about a second (see
//     BenchmarkBulkRewrite).
//
// Once the rename has succeeded the new content is in place, so a failing
// directory sync afterwards is not reported as a failed write.
//
// Because the target's inode is swapped rather than rewritten, a replacement
// differs from an in-place os.WriteFile:
//
//   - only the mode bits are carried over (the caller passes them); owner,
//     group, extended attributes and ACLs are those of a new file, and a hard
//     link to the old file keeps the old content;
//   - the target's directory must be writable, even when the file is;
//   - a read-only file in a writable directory is replaced rather than
//     refused;
//   - a symlink is followed to the file it names, which is replaced while the
//     link stays; a dangling symlink cannot be followed and is itself replaced
//     by a regular file.
package atomicfile

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// Write durably replaces path with data at mode perm.
func Write(path string, data []byte, perm os.FileMode) error {
	return write(path, data, perm, true)
}

// WriteUnsynced replaces path with data at mode perm, atomically for
// concurrent readers but without fsync: after a crash the file may hold the
// old content, or on some filesystems be empty.
func WriteUnsynced(path string, data []byte, perm os.FileMode) error {
	return write(path, data, perm, false)
}

func write(path string, data []byte, perm os.FileMode, durable bool) error {
	f, err := create(path, perm, durable)
	if err != nil {
		return err
	}
	defer f.Abort()
	if _, err := f.Write(data); err != nil {
		return fmt.Errorf("writing %s: %w", f.Name(), err)
	}
	return f.Commit()
}

// File is a pending replacement of a target path. Write to it (it is an
// *os.File), then Commit to install it or Abort to discard it; Abort after
// Commit does nothing, so `defer f.Abort()` is always safe.
type File struct {
	*os.File
	target  string
	durable bool
	done    bool
}

// IsTemp reports whether name is the name of a temp file a replacement of a
// file named target leaves behind when it is killed before its rename.
func IsTemp(name, target string) bool {
	return strings.HasPrefix(name, "."+target+"-") && strings.HasSuffix(name, ".tmp")
}

// Create starts a durable replacement of path at mode perm. The target's
// directory must exist. A path that is a symlink is followed, as os.WriteFile
// follows it: the file it names is replaced and the link stays.
func Create(path string, perm os.FileMode) (*File, error) {
	return create(path, perm, true)
}

func create(path string, perm os.FileMode, durable bool) (*File, error) {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+"-*.tmp")
	if err != nil {
		return nil, fmt.Errorf("creating temp file for %s: %w", path, err)
	}
	if err := tmp.Chmod(perm); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return nil, fmt.Errorf("setting mode of %s: %w", tmp.Name(), err)
	}
	return &File{File: tmp, target: path, durable: durable}, nil
}

// Commit closes the temp file and renames it over the target. A durable
// replacement syncs the temp file first and the target's directory after; a
// directory sync failing once the rename has landed is ignored, since the
// write itself has happened.
func (f *File) Commit() error {
	if f.done {
		return fmt.Errorf("%s: replacement already finished", f.target)
	}
	f.done = true
	name := f.Name()
	var err error
	if f.durable {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(name)
		return fmt.Errorf("writing %s: %w", name, err)
	}
	if err := os.Rename(name, f.target); err != nil {
		os.Remove(name)
		return fmt.Errorf("replacing %s: %w", f.target, err)
	}
	if f.durable {
		_ = SyncDir(filepath.Dir(f.target))
	}
	return nil
}

// Abort discards an uncommitted replacement, leaving the target untouched.
func (f *File) Abort() {
	if f.done {
		return
	}
	f.done = true
	f.Close()
	os.Remove(f.Name())
}

// SyncDir fsyncs dir so a just-completed rename or removal in it survives
// power loss on filesystems that need an explicit directory sync. A filesystem
// that cannot sync a directory (ENOTSUP/EINVAL — some network and FUSE mounts)
// is tolerated: it never offered the durability the sync buys, and refusing to
// write there would trade a narrower crash window for a tool that cannot run.
func SyncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	if err := d.Sync(); err != nil && !TolerableSyncError(err) {
		return fmt.Errorf("syncing directory %s: %w", dir, err)
	}
	return nil
}

// TolerableSyncError reports fsync refusals from filesystems that simply do
// not support it. ENOTSUP and EOPNOTSUPP are the same errno on Linux but
// distinct on Darwin, so both are listed.
func TolerableSyncError(err error) bool {
	return errors.Is(err, syscall.EINVAL) || errors.Is(err, syscall.ENOTSUP) || errors.Is(err, syscall.EOPNOTSUPP)
}
