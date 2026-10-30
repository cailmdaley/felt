package progstatus

import (
	"fmt"
	"testing"

	"golang.org/x/sys/unix"
)

const getTermios = unix.TCGETS
const setTermios = unix.TCSETS

func unlockPTY(t *testing.T, master int) string {
	t.Helper()
	if err := unix.IoctlSetPointerInt(master, unix.TIOCSPTLCK, 0); err != nil {
		t.Fatal(err)
	}
	n, err := unix.IoctlGetInt(master, unix.TIOCGPTN)
	if err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("/dev/pts/%d", n)
}
