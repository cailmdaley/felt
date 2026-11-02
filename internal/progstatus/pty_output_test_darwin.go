//go:build darwin

package progstatus

import (
	"testing"

	"golang.org/x/sys/unix"
)

func stopPTYOutput(t *testing.T, slave int) {
	t.Helper()
	if err := unix.IoctlSetInt(slave, unix.TIOCSTOP, 0); err != nil {
		t.Fatalf("stopping PTY output: %v", err)
	}
}
