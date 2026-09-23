//go:build !windows

package cmd

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

type bridgeHarness struct {
	cmd             *exec.Cmd
	input, output   *os.File
	socket, envFile string
	stderr          bytes.Buffer
	done            chan error
}

func bridgeTempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "fdb-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

func buildBridgeBinary(t *testing.T, fake bool) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "bridge")
	args := []string{"build", "-o", path, ".."}
	if fake {
		args = []string{"build", "-tags", "bridge_test", "-o", path, "./testdata/codex_bridge"}
	}
	if out, err := exec.Command("go", args...).CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	return path
}

func newBridgeHarness(t *testing.T, extraEnv ...string) *bridgeHarness {
	t.Helper()
	dir := bridgeTempDir(t)
	h := &bridgeHarness{socket: filepath.Join(dir, "private", "app-server.sock"), envFile: filepath.Join(dir, "native.json"), done: make(chan error, 1)}
	native := buildBridgeBinary(t, true)
	cli := buildBridgeBinary(t, false)
	inR, inW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	h.input, h.output = inW, outR
	h.cmd = exec.Command(cli, "shuttle", "codex-desktop-bridge", "--codex", native, "--socket", h.socket, "--", "-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled", "-c", "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true")
	h.cmd.Stdin, h.cmd.Stdout, h.cmd.Stderr = inR, outW, &h.stderr
	h.cmd.Env = append(os.Environ(), "FELT_BRIDGE_SOCKET="+h.socket, "FELT_BRIDGE_ENV_FILE="+h.envFile, "CODEX_CLI_PATH=/wrapper/not/native", "CODEX_APP_TOOLS_PIPE_PATH=/private/app-tools.pipe")
	h.cmd.Env = append(h.cmd.Env, extraEnv...)
	for _, setting := range extraEnv {
		if setting == "FELT_BRIDGE_TEST_ALREADY_ISOLATED=1" {
			h.cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		}
	}
	t.Cleanup(func() {
		h.input.Close()
		h.output.Close()
		inR.Close()
		outW.Close()
		if h.cmd.Process != nil {
			_ = h.cmd.Process.Kill()
		}
	})
	if err := h.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	inR.Close()
	outW.Close()
	go func() { h.done <- h.cmd.Wait() }()
	return h
}

func bridgeEventually(t *testing.T, what string, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("timed out: " + what)
}

func (h *bridgeHarness) wait(t *testing.T) error {
	t.Helper()
	select {
	case err := <-h.done:
		return err
	case <-time.After(12 * time.Second):
		t.Fatal("bridge did not exit")
		return nil
	}
}

func (h *bridgeHarness) clean(t *testing.T) {
	t.Helper()
	bridgeEventually(t, "endpoint and relay lock cleanup", func() bool {
		_, err := os.Lstat(h.socket)
		lock, e := os.ReadFile(h.socket + ".lock")
		return errors.Is(err, os.ErrNotExist) && e == nil && len(lock) == 0
	})
}

func (h *bridgeHarness) native(t *testing.T) map[string]string {
	t.Helper()
	var env map[string]string
	bridgeEventually(t, "native metadata", func() bool {
		data, err := os.ReadFile(h.envFile)
		return err == nil && json.Unmarshal(data, &env) == nil
	})
	return env
}

func TestCodexDesktopBridgeRoundTripPreservesProcessBoundary(t *testing.T) {
	h := newBridgeHarness(t)
	input := `{"id":1,"blob":"` + strings.Repeat("x", 1<<20) + `"}` + "\n"
	write := make(chan error, 1)
	go func() { _, err := h.input.Write([]byte(input)); write <- err }()
	reply := make(chan string, 1)
	go func() { line, _ := bufio.NewReader(h.output).ReadString('\n'); reply <- line }()
	select {
	case got := <-reply:
		if got != input {
			t.Fatalf("echo size=%d want=%d", len(got), len(input))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("echo timeout")
	}
	if err := <-write; err != nil {
		t.Fatal(err)
	}
	env := h.native(t)
	if env["FELT_BRIDGE_HELPER_PID"] != strconv.Itoa(h.cmd.Process.Pid) || env["FELT_BRIDGE_NATIVE_PPID"] != strconv.Itoa(os.Getpid()) {
		t.Fatalf("native ancestry=%v", env)
	}
	if env["CODEX_CLI_PATH"] == "/wrapper/not/native" || env["CODEX_APP_TOOLS_PIPE_PATH"] != "/private/app-tools.pipe" {
		t.Fatalf("environment=%v", env)
	}
	if env["FELT_BRIDGE_LISTEN"] != "unix://"+h.socket {
		t.Fatalf("listen=%q", env["FELT_BRIDGE_LISTEN"])
	}
	h.input.Close()
	h.wait(t)
	h.clean(t)
}

func TestCodexDesktopBridgeNativeExitCleansEndpoint(t *testing.T) {
	h := newBridgeHarness(t)
	h.native(t)
	bridgeEventually(t, "endpoint", func() bool { _, e := os.Stat(h.socket); return e == nil })
	if err := h.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	h.wait(t)
	h.clean(t)
}

func TestCodexDesktopBridgeAlreadyIsolatedProcess(t *testing.T) {
	h := newBridgeHarness(t, "FELT_BRIDGE_TEST_ALREADY_ISOLATED=1")
	h.native(t)
	h.input.Close()
	h.wait(t)
	h.clean(t)
}

func TestCodexDesktopBridgeRefusesConcurrentOwner(t *testing.T) {
	h := newBridgeHarness(t)
	h.native(t)
	cli, native := buildBridgeBinary(t, false), buildBridgeBinary(t, true)
	command := exec.Command(cli, "shuttle", "codex-desktop-bridge", "--codex", native, "--socket", h.socket, "--", "app-server")
	output, err := command.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "another bridge already owns") {
		t.Fatalf("error=%v output=%s", err, output)
	}
	if _, err := h.input.Write([]byte("{}\n")); err != nil {
		t.Fatal(err)
	}
	if err := h.output.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(h.output).ReadString('\n')
	if err != nil || line != "{}\n" {
		t.Fatalf("original owner reply=%q error=%v", line, err)
	}
	h.input.Close()
	h.wait(t)
	h.clean(t)
}

func TestCodexDesktopBridgeEmptyStdinStopsNative(t *testing.T) {
	h := newBridgeHarness(t)
	h.input.Close()
	h.wait(t)
	h.clean(t)
}

func TestCodexDesktopBridgeTimeoutStopsNative(t *testing.T) {
	h := newBridgeHarness(t, "FELT_BRIDGE_NO_SOCKET=1")
	h.native(t)
	if err := h.wait(t); err == nil {
		t.Fatal("expected startup timeout")
	}
	h.clean(t)
	if !strings.Contains(h.stderr.String(), "timed out waiting") {
		t.Fatalf("stderr=%s", h.stderr.String())
	}
}

func TestCodexDesktopBridgeBlockedStdoutShutdown(t *testing.T) {
	for _, mode := range []string{"stdin-eof", "parent-exit"} {
		t.Run(mode, func(t *testing.T) {
			h := newBridgeHarness(t, "FELT_BRIDGE_LARGE_REPLY=1")
			h.native(t)
			if _, err := h.input.Write([]byte("{\"id\":1}\n")); err != nil {
				t.Fatal(err)
			}
			// Read one byte, leaving the rest of a 1 MiB response blocked in the pipe.
			first := make(chan error, 1)
			go func() { var b [1]byte; _, e := h.output.Read(b[:]); first <- e }()
			select {
			case err := <-first:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(4 * time.Second):
				t.Fatal("no output")
			}
			if mode == "stdin-eof" {
				h.input.Close()
			} else {
				h.cmd.Process.Signal(syscall.SIGTERM)
			}
			h.wait(t)
			h.clean(t)
		})
	}
}

func TestCodexDesktopBridgeRefusesPreexistingEndpoint(t *testing.T) {
	dir := bridgeTempDir(t)
	socket := filepath.Join(dir, "existing.sock")
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	before, _ := os.Lstat(socket)
	cli, native := buildBridgeBinary(t, false), buildBridgeBinary(t, true)
	command := exec.Command(cli, "shuttle", "codex-desktop-bridge", "--codex", native, "--socket", socket, "--", "app-server")
	out, err := command.CombinedOutput()
	if err == nil || !strings.Contains(string(out), "pre-existing") {
		t.Fatalf("err=%v out=%s", err, out)
	}
	after, _ := os.Lstat(socket)
	if after == nil || !os.SameFile(before, after) {
		t.Fatal("existing endpoint was changed")
	}
}

func TestCodexDesktopBridgeExecFailureReapsRelay(t *testing.T) {
	dir := bridgeTempDir(t)
	native := filepath.Join(dir, "not-executable")
	socket := filepath.Join(dir, "private", "app-server.sock")
	if err := os.WriteFile(native, []byte("#!/bin/sh\nexit 0\n"), 0600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(buildBridgeBinary(t, false), "shuttle", "codex-desktop-bridge", "--codex", native, "--socket", socket, "--", "app-server")
	out, err := command.CombinedOutput()
	if err == nil || !strings.Contains(string(out), "exec native Codex") {
		t.Fatalf("err=%v out=%s", err, out)
	}
	lock, err := os.ReadFile(socket + ".lock")
	if err != nil {
		t.Fatal(err)
	}
	var relay int
	_, err = fmt.Sscanf(string(lock), "relay_pid=%d", &relay)
	if err != nil {
		t.Fatal(err)
	}
	if err := syscall.Kill(relay, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("relay %d alive: %v", relay, err)
	}
	if _, err := os.Lstat(socket); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("endpoint exists: %v", err)
	}
}

func TestCodexDesktopBridgePassthroughPreservesPIDAndExitCode(t *testing.T) {
	native := buildBridgeBinary(t, true)
	marker := filepath.Join(t.TempDir(), "native.json")
	command := exec.Command(buildBridgeBinary(t, false), "shuttle", "codex-desktop-bridge", "--codex", native, "--", "--version")
	command.Env = append(os.Environ(), "FELT_BRIDGE_PASSTHROUGH=1", "FELT_BRIDGE_ENV_FILE="+marker)
	err := command.Run()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != 23 {
		t.Fatalf("exit=%v", err)
	}
	data, e := os.ReadFile(marker)
	if e != nil {
		t.Fatal(e)
	}
	var env map[string]string
	if e := json.Unmarshal(data, &env); e != nil {
		t.Fatal(e)
	}
	if env["FELT_BRIDGE_HELPER_PID"] != strconv.Itoa(command.Process.Pid) || env["CODEX_CLI_PATH"] != native {
		t.Fatalf("native identity=%v", env)
	}
}

func TestClassifyCodexInvocation(t *testing.T) {
	if mode, err := classifyCodexInvocation([]string{"--version"}); err != nil || mode != bridgePassthrough {
		t.Fatalf("mode=%v err=%v", mode, err)
	}
	for _, args := range [][]string{{"app-server", "proxy"}, {"app-server", "--listen", "unix:///tmp/x"}} {
		if _, err := classifyCodexInvocation(args); err == nil {
			t.Fatalf("accepted %q", args)
		}
	}
}
