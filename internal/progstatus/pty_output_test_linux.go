//go:build linux

package progstatus

import (
	"testing"

	"golang.org/x/sys/unix"
)

func stopPTYOutput(t *testing.T, slave int) {
	t.Helper()
	if err := unix.IoctlSetInt(slave, unix.TCXONC, unix.TCOOFF); err != nil {
		t.Fatalf("stopping PTY output: %v", err)
	}
}
