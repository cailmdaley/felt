//go:build !windows

package shuttlecli

import (
	"os"
	"syscall"
	"time"
)

// flockWithin takes an exclusive flock on lockPath, waiting in the kernel's
// queue so holders are granted it in turn, for at most wait. Past wait it
// fails with errLockWait; the abandoned request stays queued and gives the
// lock straight back if it is granted later. It fails with the filesystem's
// error when the lock file will not open or the filesystem refuses flock (a
// network mount without lock support answers ENOSYS or EOPNOTSUPP).
func flockWithin(lockPath string, wait time.Duration) (unlock func(), err error) {
	file, err := os.OpenFile(lockPath, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, err
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
			return nil, err
		}
		return release, nil
	case <-timer.C:
		go func() {
			if <-granted == nil {
				release()
			} else {
				_ = file.Close()
			}
		}()
		return nil, errLockWait
	}
}
