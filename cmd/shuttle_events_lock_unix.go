//go:build !windows

package cmd

import (
	"os"
	"syscall"
	"time"
)

// eventsRotationLockWait bounds how long a hook waits for another writer's
// rotation to finish.
const eventsRotationLockWait = 2 * time.Second

// lockEventsRotation takes an exclusive flock on the rotation lock file,
// polling without blocking for at most eventsRotationLockWait. ok is false
// when the lock could not be opened or taken in time.
func lockEventsRotation(lockPath string) (unlock func(), ok bool) {
	file, err := os.OpenFile(lockPath, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, false
	}
	deadline := time.Now().Add(eventsRotationLockWait)
	for {
		err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return func() {
				_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
				_ = file.Close()
			}, true
		}
		if err != syscall.EWOULDBLOCK || time.Now().After(deadline) {
			_ = file.Close()
			return nil, false
		}
		time.Sleep(10 * time.Millisecond)
	}
}
