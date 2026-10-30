//go:build darwin || linux

package messaging

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// TestProcessTTYChild is re-executed with a private PTY and synchronization
// pipes. The parent waits for readiness before inspecting kernel metadata.
func TestProcessTTYChild(t *testing.T) {
	if len(os.Args) < 3 || os.Args[len(os.Args)-2] != "process-tty-child" {
		return
	}
	ready := os.NewFile(3, "ready")
	if os.Args[len(os.Args)-1] == "redirect" {
		f, err := os.OpenFile("/dev/null", os.O_RDWR, 0)
		if err != nil {
			fmt.Fprint(ready, err)
			os.Exit(1)
		}
		for fd := 0; fd < 3; fd++ {
			if err := unix.Dup2(int(f.Fd()), fd); err != nil {
				fmt.Fprint(ready, err)
				os.Exit(1)
			}
		}
		f.Close()
	}
	ready.Write([]byte("ready"))
	ready.Close()
	io.Copy(io.Discard, os.NewFile(4, "release"))
	os.Exit(0)
}

func startProcessTTYChild(t *testing.T, mode string, controlling bool) (pid int, path string) {
	t.Helper()
	master, err := unix.Open("/dev/ptmx", unix.O_RDWR|unix.O_NOCTTY|unix.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { unix.Close(master) })
	path = unlockProcessPTY(t, master)
	slaveFD, err := unix.Open(path, unix.O_RDWR|unix.O_NOCTTY|unix.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	slave := os.NewFile(uintptr(slaveFD), path)
	t.Cleanup(func() { slave.Close() })
	readyR, readyW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { readyR.Close(); readyW.Close() })
	releaseR, releaseW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { releaseR.Close(); releaseW.Close() })
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "-test.run=^TestProcessTTYChild$", "--", "process-tty-child", mode)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = slave, slave, slave
	cmd.ExtraFiles = []*os.File{readyW, releaseR}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: controlling, Ctty: 0}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cmd.Process.Kill()
		cmd.Wait()
	})
	readyW.Close()
	releaseR.Close()
	if err := readyR.SetReadDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(readyR)
	if err != nil || string(b) != "ready" {
		t.Fatalf("child readiness = %q, %v", b, err)
	}
	return cmd.Process.Pid, path
}

func TestProcessTTYControllingPTY(t *testing.T) {
	for _, mode := range []string{"stdio", "redirect"} {
		t.Run(mode, func(t *testing.T) {
			pid, path := startProcessTTYChild(t, mode, true)
			if got := ProcessTTY(pid, os.Geteuid()); got != path {
				t.Fatalf("ProcessTTY(%d) = %q, want controlling slave %q", pid, got, path)
			}
			if got := ProcessTTY(pid, os.Geteuid()+1); got != "" {
				t.Fatalf("ProcessTTY with wrong device owner = %q", got)
			}
		})
	}
}

func TestProcessTTYWithoutControllingTerminal(t *testing.T) {
	// The child's fd links point to a PTY, but Setsid without Setctty leaves
	// its controlling terminal absent. FD links alone must not select a tty.
	pid, _ := startProcessTTYChild(t, "stdio", false)
	if got := ProcessTTY(pid, os.Geteuid()); got != "" {
		t.Fatalf("ProcessTTY for detached child = %q, want empty", got)
	}
}

func TestProcessTTYUnavailable(t *testing.T) {
	for _, pid := range []int{-1, 0, 1 << 30} {
		if got := ProcessTTY(pid, os.Geteuid()); got != "" {
			t.Errorf("ProcessTTY(%d) = %q, want empty", pid, got)
		}
	}
	if got := ProcessTTY(os.Getpid(), -1); got != "" {
		t.Errorf("ProcessTTY with invalid owner = %q", got)
	}
	if got := ProcessTTY(os.Getpid(), os.Geteuid()); got != "" {
		info, err := os.Stat(got)
		if err != nil {
			t.Fatal(err)
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || int(stat.Uid) != os.Geteuid() || info.Mode()&os.ModeCharDevice == 0 {
			t.Fatalf("ProcessTTY for test process returned a non-owned terminal: %q", got)
		}
	}
}

func TestProcessTTYDeviceMatch(t *testing.T) {
	_, path := startProcessTTYChild(t, "stdio", true)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	dev := int32(info.Sys().(*syscall.Stat_t).Rdev)
	if !matchesTTY(path, os.Geteuid(), dev) {
		t.Fatal("owned matching PTY rejected")
	}
	if matchesTTY(path, os.Geteuid()+1, dev) || matchesTTY(path, os.Geteuid(), dev+1) {
		t.Fatal("wrong device owner or device number accepted")
	}
	regular, err := os.CreateTemp(t.TempDir(), "not-a-tty")
	if err != nil {
		t.Fatal(err)
	}
	regular.Close()
	if matchesTTY(regular.Name(), os.Geteuid(), 0) || matchesTTY(regular.Name()+"-absent", os.Geteuid(), dev) {
		t.Fatal("non-device or missing path accepted")
	}
}
