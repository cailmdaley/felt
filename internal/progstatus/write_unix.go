//go:build darwin || linux

package progstatus

import (
	"io"
	"os"

	"golang.org/x/sys/unix"
)

// Write opens path independently of the agent's descriptors and attempts one
// nonblocking write only when the tty output queue holds fewer than 256 bytes.
// A busy queue returns EAGAIN; an unreadable queue emits nothing. Keeping the
// queue nearly empty reduces the risk of a partial escape sequence. A short
// write returns io.ErrShortWrite and is never retried. Raw Unix I/O avoids
// os.File.Write's readiness polling even with O_NONBLOCK.
func Write(path string, b []byte) error {
	return writeWithQueue(path, b, func(fd int) (int, error) {
		return unix.IoctlGetInt(fd, unix.TIOCOUTQ)
	})
}

func writeWithQueue(path string, b []byte, outputQueue func(int) (int, error)) error {
	fd, err := unix.Open(path, unix.O_WRONLY|unix.O_NOCTTY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return &os.PathError{Op: "open", Path: path, Err: err}
	}
	defer unix.Close(fd)
	queued, err := outputQueue(fd)
	if err != nil {
		return &os.PathError{Op: "ioctl", Path: path, Err: err}
	}
	if queued < 0 || queued >= 256 {
		return &os.PathError{Op: "write", Path: path, Err: unix.EAGAIN}
	}
	n, err := unix.Write(fd, b)
	if err == nil && n != len(b) {
		err = io.ErrShortWrite
	}
	if err != nil {
		return &os.PathError{Op: "write", Path: path, Err: err}
	}
	return nil
}
