package messaging

import (
	"errors"
	"os"
	"path/filepath"
)

// ensureDir creates path and syncs each newly affected directory entry. This
// improves crash durability on filesystems that honor directory fsync; it does
// not claim guarantees beyond the host filesystem and storage stack.
func ensureDir(path string, mode os.FileMode) error {
	ancestor := path
	for {
		_, err := os.Stat(ancestor)
		if err == nil {
			break
		}
		if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		parent := filepath.Dir(ancestor)
		if parent == ancestor {
			break
		}
		ancestor = parent
	}
	if err := os.MkdirAll(path, mode); err != nil {
		return err
	}
	for current := path; ; current = filepath.Dir(current) {
		if err := syncDir(current); err != nil {
			return err
		}
		if current == ancestor {
			return nil
		}
		parent := filepath.Dir(current)
		if parent == current {
			return nil
		}
	}
}

func syncDir(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}
