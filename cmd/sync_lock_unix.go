//go:build !windows

package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

func lockSyncRepository(commonDir string) (func(), error) {
	file, err := os.OpenFile(filepath.Join(commonDir, "felt-sync.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, fmt.Errorf("opening felt sync lock: %w", err)
	}
	deadline := time.Now().Add(syncGitTimeout)
	for {
		err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return func() {
				_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
				_ = file.Close()
			}, nil
		}
		if err != syscall.EWOULDBLOCK && err != syscall.EAGAIN {
			_ = file.Close()
			return nil, fmt.Errorf("locking felt store Git repository: %w", err)
		}
		if time.Now().After(deadline) {
			_ = file.Close()
			return nil, fmt.Errorf("timed out waiting for another `felt sync` in this Git repository")
		}
		time.Sleep(50 * time.Millisecond)
	}
}
