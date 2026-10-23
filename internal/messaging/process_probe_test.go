package messaging

import (
	"errors"
	"os"
	"runtime"
	"syscall"
	"testing"
)

func TestProcessIdentityObservation(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, start string
		signalErr   error
		want        ProcessIdentity
	}{
		{"linux ticks", "123456", nil, ProcessIdentity{Status: "present", Start: "123456"}},
		{"darwin timeval", "1700000000.123456", nil, ProcessIdentity{Status: "present", Start: "1700000000.123456"}},
		{"absent", "", syscall.ESRCH, ProcessIdentity{Status: "gone"}},
		{"absent wrapped", "", errors.Join(errors.New("kill"), syscall.ESRCH), ProcessIdentity{Status: "gone"}},
		{"alive unreadable", "", nil, ProcessIdentity{Status: "unknown"}},
		{"permission denied", "", syscall.EPERM, ProcessIdentity{Status: "unknown"}},
		{"other failure", "", syscall.EIO, ProcessIdentity{Status: "unknown"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := probeProcessIdentity(42, func(int) string { return tc.start }, func(int) error { return tc.signalErr })
			if got != tc.want {
				t.Fatalf("observation = %#v, want %#v", got, tc.want)
			}
		})
	}
	for _, pid := range []int{0, -1} {
		got := probeProcessIdentity(pid, func(int) string { t.Fatal("read invalid PID"); return "" }, func(int) error { t.Fatal("signal invalid PID"); return nil })
		if got.Status != "unknown" {
			t.Fatalf("invalid PID = %#v", got)
		}
	}
}

func TestProcessIdentityCurrentKernelProcess(t *testing.T) {
	t.Parallel()
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("kernel probe supports Darwin and Linux")
	}
	got := ProbeProcessIdentity(os.Getpid())
	if got.Status != "present" || got.Start == "" || got.Start != processStartToken(os.Getpid()) {
		t.Fatalf("current process lifetime: %#v", got)
	}
}
