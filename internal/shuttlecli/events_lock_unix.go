//go:build !windows

package shuttlecli

import (
	"os"
	"syscall"
	"time"
)

// lockEventsRotation takes an exclusive flock on the rotation lock file,
// waiting in the kernel's queue so writers are granted it in turn. A holder
// only stats, renames and appends, and the kernel drops its lock when it
// exits, but the stream may live on a network filesystem where a live holder
// can stall in I/O; ok is false when the lock is not granted within wait. The
// abandoned request stays queued and gives the lock straight back if it is
// granted later. A lock that cannot be used at all — the file won't open, or
// the filesystem refuses flock (a network mount without lock support answers
// ENOSYS or EOPNOTSUPP) — returns ok with a no-op unlock, so rotation proceeds
// unguarded rather than never happening and letting the stream grow without
// bound.
func lockEventsRotation(lockPath string, wait time.Duration) (unlock func(), ok bool) {
	file, err := os.OpenFile(lockPath, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return func() {}, true
	}
	fd := int(file.Fd())
	granted := make(chan error, 1)
	go func() {
		for {
			err := syscall.Flock(fd, syscall.LOCK_EX)
			if err != syscall.EINTR {
				granted <- err
				return
			}
		}
	}()
	release := func() {
		_ = syscall.Flock(fd, syscall.LOCK_UN)
		_ = file.Close()
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case err := <-granted:
		if err != nil {
			_ = file.Close()
			return func() {}, true
		}
		return release, true
	case <-timer.C:
		go func() {
			<-granted
			release()
		}()
		return nil, false
	}
}
