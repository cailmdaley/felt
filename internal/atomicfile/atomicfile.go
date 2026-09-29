// Package atomicfile replaces files so that a concurrent reader sees either
// the old content or the new, never a truncated or half-written file.
//
// A replacement is written to a temp file in the target's own directory (a
// rename is atomic only within one filesystem), under a hidden name ending in
// .tmp that felt's store walkers never read as a fiber. The temp file is
// fsynced, given the intended mode (os.CreateTemp makes it 0600), and renamed
// over the target; the parent directory is then fsynced so the rename itself
// survives power loss wherever the filesystem honours a directory sync.
package atomicfile

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// Write replaces path with data at mode perm.
func Write(path string, data []byte, perm os.FileMode) error {
	f, err := Create(path, perm)
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
	target string
	done   bool
}

// IsTemp reports whether name is the name of a temp file a replacement of a
// file named target leaves behind when it is killed before its rename.
func IsTemp(name, target string) bool {
	return strings.HasPrefix(name, "."+target+"-") && strings.HasSuffix(name, ".tmp")
}

// Create starts a replacement of path at mode perm. The target's directory
// must exist. A path that is a symlink is followed, as os.WriteFile follows
// it: the file it names is replaced and the link stays.
func Create(path string, perm os.FileMode) (*File, error) {
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
	return &File{File: tmp, target: path}, nil
}

// Commit syncs and closes the temp file, renames it over the target, and
// syncs the target's directory.
func (f *File) Commit() error {
	if f.done {
		return fmt.Errorf("%s: replacement already finished", f.target)
	}
	f.done = true
	name := f.Name()
	err := f.Sync()
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
	return SyncDir(filepath.Dir(f.target))
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
