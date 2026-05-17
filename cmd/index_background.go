package cmd

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
)

const indexSyncDebounce = 500 * time.Millisecond

func runBackgroundIndexSync(storage *felt.Storage) error {
	lock, locked, err := acquireIndexSyncLock(storage)
	if err != nil {
		return err
	}
	if !locked {
		return nil
	}
	defer lock.Close()

	for {
		time.Sleep(indexSyncDebounce)
		start := time.Now()
		if _, err := syncIndex(storage); err != nil {
			return err
		}
		requestedAt, err := indexSyncRequestedAt(storage)
		if errors.Is(err, os.ErrNotExist) || !requestedAt.After(start) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func touchIndexSyncRequest(storage *felt.Storage) error {
	path := indexSyncRequestPath(storage)
	now := time.Now()
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(file, "%s\n", now.Format(time.RFC3339Nano)); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Chtimes(path, now, now)
}

func indexSyncRequestedAt(storage *felt.Storage) (time.Time, error) {
	info, err := os.Stat(indexSyncRequestPath(storage))
	if err != nil {
		return time.Time{}, err
	}
	return info.ModTime(), nil
}

func acquireIndexSyncLock(storage *felt.Storage) (*os.File, bool, error) {
	lock, err := os.OpenFile(indexSyncLockPath(storage), os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		return nil, false, err
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = lock.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, false, nil
		}
		return nil, false, err
	}
	_ = lock.Truncate(0)
	_, _ = fmt.Fprintf(lock, "pid=%d\n", os.Getpid())
	return lock, true, nil
}

func indexSyncRequestPath(storage *felt.Storage) string {
	return filepath.Join(storage.ProjectRoot(), felt.DirName, "index-sync.request")
}

func indexSyncLockPath(storage *felt.Storage) string {
	return filepath.Join(storage.ProjectRoot(), felt.DirName, "index-sync.lock")
}
