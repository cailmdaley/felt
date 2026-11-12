//go:build !windows

package shuttlecli

import (
	"os"
	"syscall"
)

// lockEventsRotation takes an exclusive flock on the rotation lock file,
// waiting in the kernel's queue until it is granted. A holder only stats,
// renames and appends to a local file, and the kernel drops its lock when it
// exits, so the wait is short and cannot outlive a dead writer. A lock that
// cannot be used at all — the file won't open, or the filesystem refuses
// flock (a network mount without lock support answers ENOSYS or EOPNOTSUPP) —
// returns a no-op unlock, so rotation proceeds unguarded rather than never
// happening and letting the stream grow without bound.
func lockEventsRotation(lockPath string) (unlock func()) {
	file, err := os.OpenFile(lockPath, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return func() {}
	}
	for {
		err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX)
		if err != syscall.EINTR {
			break
		}
	}
	if err != nil {
		_ = file.Close()
		return func() {}
	}
	return func() {
		_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
		_ = file.Close()
	}
}
