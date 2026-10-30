//go:build darwin || linux

package progstatus

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// openPTY opens a fresh kernel PTY without invoking a helper process. Both
// descriptors are nonblocking and close-on-exec; cleanup closes the slave first.
func openPTY(t *testing.T) (master, slave int, path string) {
	t.Helper()
	master, err := unix.Open("/dev/ptmx", unix.O_RDWR|unix.O_NOCTTY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { unix.Close(master) })
	path = unlockPTY(t, master)
	slave, err = unix.Open(path, unix.O_RDWR|unix.O_NOCTTY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { unix.Close(slave) })
	// In particular, disable output processing so the master sees the exact bytes.
	termios, err := unix.IoctlGetTermios(slave, getTermios)
	if err != nil {
		t.Fatal(err)
	}
	termios.Iflag &^= unix.IGNBRK | unix.BRKINT | unix.PARMRK | unix.ISTRIP | unix.INLCR | unix.IGNCR | unix.ICRNL | unix.IXON
	termios.Oflag &^= unix.OPOST
	termios.Lflag &^= unix.ECHO | unix.ECHONL | unix.ICANON | unix.ISIG | unix.IEXTEN
	termios.Cflag &^= unix.CSIZE | unix.PARENB
	termios.Cflag |= unix.CS8
	termios.Cc[unix.VMIN] = 1
	termios.Cc[unix.VTIME] = 0
	if err := unix.IoctlSetTermios(slave, setTermios, termios); err != nil {
		t.Fatal(err)
	}
	return master, slave, path
}

func TestWritePTYExactReport(t *testing.T) {
	master, slave, path := openPTY(t)
	before, err := unix.FcntlInt(uintptr(slave), unix.F_GETFL, 0)
	if err != nil {
		t.Fatal(err)
	}
	report := WrapTmux((Report{State: "blocked", Kind: "permission", App: "child", Title: "task", Msg: "child"}).Encode())
	if err := Write(path, report); err != nil {
		t.Fatal(err)
	}
	var got []byte
	deadline := time.Now().Add(5 * time.Second)
	for len(got) < len(report) {
		if time.Now().After(deadline) {
			t.Fatalf("PTY read timed out after %q", got)
		}
		poll := []unix.PollFd{{Fd: int32(master), Events: unix.POLLIN}}
		if _, err := unix.Poll(poll, 100); err != nil && !errors.Is(err, unix.EINTR) {
			t.Fatal(err)
		}
		buf := make([]byte, 4096)
		n, err := unix.Read(master, buf)
		if errors.Is(err, unix.EAGAIN) || errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, buf[:n]...)
	}
	if !bytes.Equal(got, report) {
		t.Fatalf("PTY got %q, want exactly %q", got, report)
	}
	after, err := unix.FcntlInt(uintptr(slave), unix.F_GETFL, 0)
	if err != nil || before != after {
		t.Fatalf("Write changed the existing slave descriptor flags: %x -> %x, %v", before, after, err)
	}
}

func TestWritePTYFullFailsFast(t *testing.T) {
	master, slave, path := openPTY(t)
	fillPTY(t, slave)

	type result struct {
		err     error
		elapsed time.Duration
	}
	done := make(chan result, 1)
	go func() {
		start := time.Now()
		err := Write(path, (Report{State: "working", App: "child"}).Encode())
		done <- result{err, time.Since(start)}
	}()
	select {
	case r := <-done:
		if !errors.Is(r.err, unix.EAGAIN) && !errors.Is(r.err, io.ErrShortWrite) {
			t.Fatalf("full PTY Write = %v, want EAGAIN or short write", r.err)
		}
		if r.elapsed >= 100*time.Millisecond {
			t.Fatalf("full PTY Write took %s, want under 100ms", r.elapsed)
		}
	case <-time.After(time.Second):
		// Let an incorrectly polling writer finish before descriptor cleanup.
		buf := make([]byte, 65536)
		for {
			if _, err := unix.Read(master, buf); err != nil {
				break
			}
		}
		select {
		case <-done:
		case <-time.After(time.Second):
		}
		t.Fatal("Write blocked on a full PTY")
	}
}

func fillPTY(t *testing.T, slave int) {
	t.Helper()
	buf := bytes.Repeat([]byte("x"), 4096)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		_, err := unix.Write(slave, buf)
		if errors.Is(err, unix.EAGAIN) {
			// A large write may fail while a few bytes still fit.
			buf = buf[:1]
			if _, err = unix.Write(slave, buf); errors.Is(err, unix.EAGAIN) {
				return
			}
		}
		if err != nil && !errors.Is(err, unix.EINTR) {
			t.Fatal(err)
		}
	}
	t.Fatal("PTY did not fill to EAGAIN")
}

func TestWriteErrors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "absent")
	if err := Write(path, []byte("report")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Write(absent) = %v, want not-exist", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Write created the absent path: %v", err)
	}
	if err := Write(filepath.Dir(path), []byte("report")); err == nil {
		t.Fatal("Write(directory) succeeded")
	}
}
