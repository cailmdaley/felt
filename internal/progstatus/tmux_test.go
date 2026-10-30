//go:build darwin || linux

package progstatus

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// TestTmuxPassthrough checks the wire contract with a real attached tmux client,
// not capture-pane (which reads tmux's screen rather than terminal output).
func TestTmuxPassthrough(t *testing.T) {
	tmux, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux is not installed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	version, err := exec.CommandContext(ctx, tmux, "-V").CombinedOutput()
	if err != nil {
		t.Fatalf("tmux -V: %v: %s", err, version)
	}
	var major, minor int
	if n, _ := fmt.Sscanf(strings.TrimSpace(string(version)), "tmux %d.%d", &major, &minor); n != 2 || major < 3 || major == 3 && minor < 3 {
		t.Skipf("allow-passthrough requires tmux >= 3.3; found %s", strings.TrimSpace(string(version)))
	}
	t.Logf("real terminal contract with %s", strings.TrimSpace(string(version)))

	for _, passthrough := range []string{"on", "off"} {
		t.Run(passthrough, func(t *testing.T) {
			// Keep the Unix socket path short on Darwin, independent of TMPDIR.
			root, err := os.MkdirTemp("/tmp", "shuttle-status-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { os.RemoveAll(root) })
			label := filepath.Base(root)
			env := []string{
				"HOME=" + root, "XDG_CONFIG_HOME=" + root, "TMUX_TMPDIR=" + root,
				"PATH=" + os.Getenv("PATH"), "SHELL=/bin/sh", "TERM=xterm-256color", "LC_ALL=C",
			}
			command := func(ctx context.Context, args ...string) *exec.Cmd {
				cmd := exec.CommandContext(ctx, tmux, append([]string{"-L", label, "-f", "/dev/null"}, args...)...)
				cmd.Env = env
				return cmd
			}
			run := func(args ...string) string {
				t.Helper()
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				out, err := command(ctx, args...).CombinedOutput()
				if err != nil {
					t.Fatalf("tmux %q: %v: %s", args, err, out)
				}
				return strings.TrimSpace(string(out))
			}
			t.Cleanup(func() {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				if out, err := command(ctx, "kill-server").CombinedOutput(); err != nil {
					t.Errorf("private tmux kill-server: %v: %s", err, out)
				}
			})

			run("new-session", "-d", "-s", "status", "-x", "160", "-y", "48", "printf TMUX-STATUS-READY; exec sleep 600")
			pane := "status:0.0"
			run("set-option", "-p", "-t", pane, "allow-passthrough", passthrough)
			paneTTY := run("display-message", "-p", "-t", pane, "#{pane_tty}")

			master, slave, path := openPTY(t)
			if err := unix.IoctlSetWinsize(slave, unix.TIOCSWINSZ, &unix.Winsize{Col: 160, Row: 48}); err != nil {
				t.Fatal(err)
			}
			// The tmux client needs blocking stdio; open an independent descriptor
			// so the test's master remains nonblocking for bounded reads.
			stdio, err := os.OpenFile(path, os.O_RDWR|unix.O_NOCTTY, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer stdio.Close()
			client := command(context.Background(), "attach-session", "-t", "status")
			client.Stdin, client.Stdout, client.Stderr = stdio, stdio, stdio
			client.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
			if err := client.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				_ = client.Process.Kill()
				done := make(chan struct{})
				go func() { _ = client.Wait(); close(done) }()
				// Darwin can wait for queued terminal output during process exit.
				// Keep draining until the killed client is reaped.
				deadline := time.Now().Add(5 * time.Second)
				for time.Now().Before(deadline) {
					select {
					case <-done:
						return
					default:
					}
					_, _ = unix.Poll([]unix.PollFd{{Fd: int32(master), Events: unix.POLLIN}}, 100)
					_, _ = unix.Read(master, make([]byte, 8192))
				}
				t.Error("tmux client did not exit after SIGKILL")
			})
			// A rendered greeting proves both the pane program and the visible
			// client are ready; the client-attached hook alone can fire too early.
			readTmuxUntil(t, master, []byte("TMUX-STATUS-READY"))
			// Round-trip fresh pane output after the initial screen. Passthrough
			// with value "on" is discarded while tmux has a full redraw pending.
			if err := Write(paneTTY, []byte("CLIENT-READY")); err != nil {
				t.Fatal(err)
			}
			readTmuxUntil(t, master, []byte("CLIENT-READY"))

			report := (Report{State: "blocked", Kind: "permission", App: "child", Msg: "child"}).Encode()
			wrapped := WrapTmux(report)
			if passthrough == "on" {
				if err := Write(paneTTY, wrapped); err != nil {
					t.Fatal(err)
				}
				// Independent byte oracle: probe B2's OSC, without the DCS envelope.
				want := []byte("\x1b]7501;state=blocked:kind=permission:app=child:msg=Y2hpbGQ=\x1b\\")
				got := readTmuxUntil(t, master, want)
				if bytes.Contains(got, []byte("\x1bPtmux;")) {
					t.Fatalf("client received a DCS envelope rather than just its payload: %q", got)
				}
			} else {
				// One write orders the report before the visible text. Seeing the
				// sentinel proves tmux has consumed the report; no absence timeout.
				sentinel := []byte("SENTINEL")
				if err := Write(paneTTY, append(wrapped, sentinel...)); err != nil {
					t.Fatal(err)
				}
				got := readTmuxUntil(t, master, sentinel)
				if bytes.Contains(got, []byte("]7501")) {
					t.Fatalf("passthrough off leaked the status before SENTINEL: %q", got)
				}
			}
		})
	}
}

func readTmuxUntil(t *testing.T, master int, marker []byte) []byte {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var got []byte
	buf := make([]byte, 8192)
	for !bytes.Contains(got, marker) {
		if time.Now().After(deadline) {
			t.Fatalf("tmux client timed out waiting for %q; output: %q", marker, got)
		}
		poll := []unix.PollFd{{Fd: int32(master), Events: unix.POLLIN}}
		if _, err := unix.Poll(poll, 100); err != nil && !errors.Is(err, unix.EINTR) {
			t.Fatal(err)
		}
		n, err := unix.Read(master, buf)
		if errors.Is(err, unix.EAGAIN) || errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil || n == 0 {
			t.Fatalf("tmux client read: n=%d, err=%v; output: %q", n, err, got)
		}
		got = append(got, buf[:n]...)
		if len(got) > 1<<20 {
			t.Fatalf("tmux client exceeded output limit waiting for %q", marker)
		}
	}
	return got
}
