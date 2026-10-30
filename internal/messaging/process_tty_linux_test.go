package messaging

import (
	"fmt"
	"os"
	"testing"

	"golang.org/x/sys/unix"
)

func unlockProcessPTY(t *testing.T, master int) string {
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

func TestProcessTTYLinuxRejectsMismatchedFD(t *testing.T) {
	pid, _ := startProcessTTYChild(t, "stdio", true)
	// None of the child's real fd targets may substitute for a different
	// controlling device, even though all are owned terminal nodes.
	if got := processTTYPath(pid, os.Geteuid(), -1); got != "" {
		t.Fatalf("processTTYPath for mismatched device = %q", got)
	}
}

func TestProcessTTYLinuxStat(t *testing.T) {
	for _, tc := range []struct {
		stat string
		dev  int32
		ok   bool
	}{
		{"42 (agent (with) spaces)) S 1 42 42 34821 42", 34821, true},
		{"42 (agent) S 1 42 42 -2147483647 42", -2147483647, true},
		{"42 (agent) S 1 42 42 0 42", 0, false},
		{"42 (agent) S 1 42 42 nope 42", 0, false},
		{"42 (agent) S 1 42 42 4294967296 42", 0, false},
		{"42 (agent) S 1", 0, false},
		{"42 no closing paren", 0, false},
	} {
		t.Run(tc.stat, func(t *testing.T) {
			dev, ok := linuxTTYDev(tc.stat)
			if ok != tc.ok || (ok && dev != tc.dev) {
				t.Fatalf("linuxTTYDev(%q) = %d, %t; want %d, %t", tc.stat, dev, ok, tc.dev, tc.ok)
			}
		})
	}
}
