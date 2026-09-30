//go:build !windows

package shuttlecli

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
// only when another writer holds the lock past that wait. A lock that cannot
// be used at all — the file won't open, or the filesystem refuses flock
// (a network mount without lock support answers ENOSYS or EOPNOTSUPP) —
// returns ok with a no-op unlock, so rotation proceeds unguarded rather than
// never happening and letting the stream grow without bound.
func lockEventsRotation(lockPath string) (unlock func(), ok bool) {
	file, err := os.OpenFile(lockPath, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return func() {}, true
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
		if err != syscall.EWOULDBLOCK {
			_ = file.Close()
			return func() {}, true
		}
		if time.Now().After(deadline) {
			_ = file.Close()
			return nil, false
		}
		time.Sleep(10 * time.Millisecond)
	}
}
