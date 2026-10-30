//go:build darwin || linux

package progstatus

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestWriteOutputQueueGate(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name              string
		queued            int
		queueErr, wantErr error
	}{
		{"empty", 0, nil, nil},
		{"nearly empty", 255, nil, nil},
		{"threshold", 256, nil, unix.EAGAIN},
		{"busy", 4096, nil, unix.EAGAIN},
		{"invalid count", -1, nil, unix.EAGAIN},
		{"unavailable", 0, unix.ENOTTY, unix.ENOTTY},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "output")
			if err := os.WriteFile(path, nil, 0600); err != nil {
				t.Fatal(err)
			}
			report := WrapTmux((Report{State: "working", App: "claude-code"}).Encode())
			calls := 0
			err := writeWithQueue(path, report, func(fd int) (int, error) {
				calls++
				flags, err := unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0)
				if err != nil || flags&unix.O_NONBLOCK == 0 {
					t.Fatalf("queue descriptor is not nonblocking: %x %v", flags, err)
				}
				if info, err := os.Stat(path); err != nil || info.Size() != 0 {
					t.Fatalf("write precedes queue check: %v %v", info, err)
				}
				return tc.queued, tc.queueErr
			})
			if calls != 1 || !errors.Is(err, tc.wantErr) {
				t.Fatalf("queue calls=%d error=%v, want %v", calls, err, tc.wantErr)
			}
			got, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var want []byte
			if tc.wantErr == nil {
				want = report
			}
			if !bytes.Equal(got, want) {
				t.Fatalf("wrote %q, want %q", got, want)
			}
		})
	}
}

func TestWriteSkipsNonTTY(t *testing.T) {
	path := filepath.Join(t.TempDir(), "not-a-tty")
	const sentinel = "untouched"
	if err := os.WriteFile(path, []byte(sentinel), 0600); err != nil {
		t.Fatal(err)
	}
	if err := Write(path, []byte("escape bytes")); !errors.Is(err, unix.ENOTTY) {
		t.Fatalf("Write(non-tty) = %v, want ENOTTY", err)
	}
	if got, err := os.ReadFile(path); err != nil || string(got) != sentinel {
		t.Fatalf("non-tty changed: %q %v", got, err)
	}
}
