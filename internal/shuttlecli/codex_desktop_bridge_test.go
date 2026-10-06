//go:build !windows

package shuttlecli

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
)

type bridgeHarness struct {
	cmd             *exec.Cmd
	input, output   *os.File
	socket, envFile string
	stderr          sysenvtest.Buffer
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

var bridgeBinaries struct {
	once        sync.Once
	cli, native string
	err         error
}

// bridgeBinaryPaths builds the shuttle CLI and the fake native Codex once per
// test binary, into the TestMain fence so they leave with it, and returns
// their paths.
func bridgeBinaryPaths(t *testing.T) (cli, native string) {
	t.Helper()
	b := &bridgeBinaries
	b.once.Do(func() {
		dir := filepath.Join(testFenceDir, "codex-bridge-bin")
		b.cli, b.native = filepath.Join(dir, "shuttle"), filepath.Join(dir, "native")
		builds := [][]string{
			{"build", "-o", b.cli, "../../cmd/shuttle"},
			{"build", "-tags", "bridge_test", "-o", b.native, "./testdata/codex_bridge"},
		}
		errs := make(chan error, len(builds))
		for _, args := range builds {
			go func() {
				if out, err := exec.Command("go", args...).CombinedOutput(); err != nil {
					errs <- fmt.Errorf("go %s: %v\n%s", strings.Join(args, " "), err, out)
					return
				}
				errs <- nil
			}()
		}
		for range builds {
			b.err = errors.Join(b.err, <-errs)
		}
	})
	if b.err != nil {
		t.Fatalf("build: %v", b.err)
	}
	return b.cli, b.native
}

func newBridgeHarness(t *testing.T, extraEnv ...string) *bridgeHarness {
	t.Helper()
	dir := bridgeTempDir(t)
	h := &bridgeHarness{socket: filepath.Join(dir, "private", "app-server.sock"), envFile: filepath.Join(dir, "native.json"), done: make(chan error, 1)}
	cli, native := bridgeBinaryPaths(t)
	inR, inW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	h.input, h.output = inW, outR
	h.cmd = exec.Command(cli, "codex-desktop-bridge", "--codex", native, "--socket", h.socket, "--", "-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled", "-c", "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true")
	h.cmd.Stdin, h.cmd.Stdout, h.cmd.Stderr = inR, outW, &h.stderr
	h.cmd.Env = append(os.Environ(), "SHUTTLE_BRIDGE_SOCKET="+h.socket, "SHUTTLE_BRIDGE_ENV_FILE="+h.envFile, "CODEX_CLI_PATH=/wrapper/not/native", "CODEX_APP_TOOLS_PIPE_PATH=/private/app-tools.pipe")
	h.cmd.Env = append(h.cmd.Env, extraEnv...)
	for _, setting := range extraEnv {
		if setting == "SHUTTLE_BRIDGE_TEST_ALREADY_ISOLATED=1" {
			h.cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		}
	}
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("bridge stderr: %s", h.stderr.String())
		}
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

// bridgeWaitLimit bounds every wait on a bridge, native or relay process. Each
// wait returns as soon as its event lands; the bound only decides how long a
// broken bridge takes to fail, so it is sized for a heavily loaded host and
// must stay above bridgeStartupTimeout, which TimeoutStopsNative sits through.
const bridgeWaitLimit = 20 * time.Second

func bridgeEventually(t *testing.T, what string, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(bridgeWaitLimit)
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
	case <-time.After(bridgeStartupTimeout + bridgeWaitLimit):
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

// TestCodexDesktopBridge runs the bridge cases in parallel with each other
// but not with the rest of the package: it is a sequential top-level test, so
// the package's parallel tests wait until it returns. The bridge's real
// startup and stop deadlines (bridgeStartupTimeout, bridgeStopTimeout) are
// behaviour under test, and the package's whole parallel subprocess load can
// starve a bridge past them on a loaded host.
func TestCodexDesktopBridge(t *testing.T) {
	for _, c := range []struct {
		name string
		run  func(*testing.T)
	}{
		{"RoundTripPreservesProcessBoundary", bridgeCaseRoundTripPreservesProcessBoundary},
		{"NativeExitCleansEndpoint", bridgeCaseNativeExitCleansEndpoint},
		{"AlreadyIsolatedProcess", bridgeCaseAlreadyIsolatedProcess},
		{"RefusesConcurrentOwner", bridgeCaseRefusesConcurrentOwner},
		{"UnexpectedNativeExitKillsDescendants", bridgeCaseUnexpectedNativeExitKillsDescendants},
		{"EmptyStdinStopsNative", bridgeCaseEmptyStdinStopsNative},
		{"TimeoutStopsNative", bridgeCaseTimeoutStopsNative},
		{"BlockedStdoutShutdown", bridgeCaseBlockedStdoutShutdown},
		{"RefusesPreexistingEndpoint", bridgeCaseRefusesPreexistingEndpoint},
		{"ExecFailureReapsRelay", bridgeCaseExecFailureReapsRelay},
		{"PassthroughPreservesPIDAndExitCode", bridgeCasePassthroughPreservesPIDAndExitCode},
	} {
		t.Run(c.name, c.run)
	}
}

func bridgeCaseRoundTripPreservesProcessBoundary(t *testing.T) {
	t.Parallel()
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
	case <-time.After(bridgeWaitLimit):
		t.Fatal("echo timeout")
	}
	if err := <-write; err != nil {
		t.Fatal(err)
	}
	env := h.native(t)
	if env["SHUTTLE_BRIDGE_HELPER_PID"] != strconv.Itoa(h.cmd.Process.Pid) || env["SHUTTLE_BRIDGE_NATIVE_PPID"] != strconv.Itoa(os.Getpid()) {
		t.Fatalf("native ancestry=%v", env)
	}
	if env["CODEX_CLI_PATH"] == "/wrapper/not/native" || env["CODEX_APP_TOOLS_PIPE_PATH"] != "/private/app-tools.pipe" {
		t.Fatalf("environment=%v", env)
	}
	if env["SHUTTLE_BRIDGE_LISTEN"] != "unix://"+h.socket {
		t.Fatalf("listen=%q", env["SHUTTLE_BRIDGE_LISTEN"])
	}
	h.input.Close()
	h.wait(t)
	h.clean(t)
}

func bridgeCaseNativeExitCleansEndpoint(t *testing.T) {
	t.Parallel()
	h := newBridgeHarness(t)
	h.native(t)
	bridgeEventually(t, "endpoint", func() bool { _, e := os.Stat(h.socket); return e == nil })
	if err := h.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	h.wait(t)
	h.clean(t)
}

func TestBridgeEndpointCreatedBetweenStatAndNativeExit(t *testing.T) {
	t.Parallel()
	socket := filepath.Join(bridgeTempDir(t), "native.sock")
	parentDone := make(chan struct{})
	var listener net.Listener
	stat := func(path string) (os.FileInfo, error) {
		if listener == nil {
			var err error
			listener, err = net.Listen("unix", socket)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { listener.Close() })
			if err := os.Chmod(socket, 0600); err != nil {
				t.Fatal(err)
			}
			close(parentDone)
			return nil, os.ErrNotExist
		}
		return os.Lstat(path)
	}
	endpoint, err := waitForBridgeEndpointWithStat(context.Background(), socket, parentDone, stat)
	if err != nil {
		t.Fatalf("final endpoint inspection: %v", err)
	}
	current, err := os.Lstat(socket)
	if err != nil || endpoint == nil || !os.SameFile(endpoint, current) {
		t.Fatalf("lost endpoint identity after native exit: %v, %v", endpoint, err)
	}
	removeOwnedEndpoint(socket, endpoint)
	if _, err := os.Lstat(socket); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("raced endpoint was not cleaned: %v", err)
	}
}

func TestBridgeEndpointAbsentAfterNativeExitStopsPolling(t *testing.T) {
	t.Parallel()
	parentDone := make(chan struct{})
	close(parentDone)
	calls := 0
	endpoint, err := waitForBridgeEndpointWithStat(context.Background(), "/tmp/absent-native.sock", parentDone, func(string) (os.FileInfo, error) {
		calls++
		return nil, os.ErrNotExist
	})
	if endpoint != nil || err == nil || calls != 2 {
		t.Fatalf("endpoint=%v err=%v stat calls=%d; want absent after one final inspection", endpoint, err, calls)
	}
}

func bridgeCaseAlreadyIsolatedProcess(t *testing.T) {
	t.Parallel()
	h := newBridgeHarness(t, "SHUTTLE_BRIDGE_TEST_ALREADY_ISOLATED=1")
	h.native(t)
	h.input.Close()
	h.wait(t)
	h.clean(t)
}

func bridgeCaseRefusesConcurrentOwner(t *testing.T) {
	t.Parallel()
	h := newBridgeHarness(t)
	h.native(t)
	cli, native := bridgeBinaryPaths(t)
	command := exec.Command(cli, "codex-desktop-bridge", "--codex", native, "--socket", h.socket, "--", "app-server")
	output, err := command.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "another bridge already owns") {
		t.Fatalf("error=%v output=%s", err, output)
	}
	if _, err := h.input.Write([]byte("{}\n")); err != nil {
		t.Fatal(err)
	}
	if err := h.output.SetReadDeadline(time.Now().Add(bridgeWaitLimit)); err != nil {
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

func bridgeCaseUnexpectedNativeExitKillsDescendants(t *testing.T) {
	t.Parallel()
	marker := filepath.Join(bridgeTempDir(t), "descendant.json")
	h := newBridgeHarness(t, "SHUTTLE_BRIDGE_DESCENDANT_FILE="+marker)
	h.native(t)
	var child map[string]int
	bridgeEventually(t, "descendant ready", func() bool { data, e := os.ReadFile(marker); return e == nil && json.Unmarshal(data, &child) == nil })
	if child["pgid"] != h.cmd.Process.Pid {
		t.Fatalf("descendant group=%v, native=%d", child, h.cmd.Process.Pid)
	}
	finished := false
	t.Cleanup(func() {
		if !finished {
			_ = syscall.Kill(child["pid"], syscall.SIGKILL)
		}
	})
	bridgeEventually(t, "endpoint ready", func() bool { _, e := os.Stat(h.socket); return e == nil })
	if err := h.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	// The TERM-ignoring descendant holds the captured stderr pipe open. Wait
	// cannot finish unless the relay kills that descendant after native death.
	h.wait(t)
	finished = true
	h.clean(t)
}

func bridgeCaseEmptyStdinStopsNative(t *testing.T) {
	t.Parallel()
	h := newBridgeHarness(t)
	h.input.Close()
	// Native must have started: a bridge that timed out before exec would also
	// exit and clean up.
	h.native(t)
	h.wait(t)
	h.clean(t)
	if strings.Contains(h.stderr.String(), "context canceled") {
		t.Fatalf("clean EOF logged as failure: %s", h.stderr.String())
	}
}

func bridgeCaseTimeoutStopsNative(t *testing.T) {
	t.Parallel()
	h := newBridgeHarness(t, "SHUTTLE_BRIDGE_NO_SOCKET=1")
	h.native(t)
	if err := h.wait(t); err == nil {
		t.Fatal("expected startup timeout")
	}
	h.clean(t)
	if !strings.Contains(h.stderr.String(), "timed out waiting") {
		t.Fatalf("stderr=%s", h.stderr.String())
	}
}

func bridgeCaseBlockedStdoutShutdown(t *testing.T) {
	t.Parallel()
	for _, mode := range []string{"stdin-eof", "parent-exit"} {
		t.Run(mode, func(t *testing.T) {
			t.Parallel()
			h := newBridgeHarness(t, "SHUTTLE_BRIDGE_LARGE_REPLY=1")
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
			case <-time.After(bridgeWaitLimit):
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

func bridgeCaseRefusesPreexistingEndpoint(t *testing.T) {
	t.Parallel()
	dir := bridgeTempDir(t)
	socket := filepath.Join(dir, "existing.sock")
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	before, _ := os.Lstat(socket)
	cli, native := bridgeBinaryPaths(t)
	command := exec.Command(cli, "codex-desktop-bridge", "--codex", native, "--socket", socket, "--", "app-server")
	out, err := command.CombinedOutput()
	if err == nil || !strings.Contains(string(out), "pre-existing") {
		t.Fatalf("err=%v out=%s", err, out)
	}
	after, _ := os.Lstat(socket)
	if after == nil || !os.SameFile(before, after) {
		t.Fatal("existing endpoint was changed")
	}
}

func bridgeCaseExecFailureReapsRelay(t *testing.T) {
	t.Parallel()
	dir := bridgeTempDir(t)
	native := filepath.Join(dir, "not-executable")
	socket := filepath.Join(dir, "private", "app-server.sock")
	if err := os.WriteFile(native, []byte("#!/bin/sh\nexit 0\n"), 0600); err != nil {
		t.Fatal(err)
	}
	cli, _ := bridgeBinaryPaths(t)
	command := exec.Command(cli, "codex-desktop-bridge", "--codex", native, "--socket", socket, "--", "app-server")
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

func bridgeCasePassthroughPreservesPIDAndExitCode(t *testing.T) {
	t.Parallel()
	cli, native := bridgeBinaryPaths(t)
	marker := filepath.Join(t.TempDir(), "native.json")
	command := exec.Command(cli, "codex-desktop-bridge", "--codex", native, "--", "--version")
	command.Env = append(os.Environ(), "SHUTTLE_BRIDGE_PASSTHROUGH=1", "SHUTTLE_BRIDGE_ENV_FILE="+marker)
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
	if env["SHUTTLE_BRIDGE_HELPER_PID"] != strconv.Itoa(command.Process.Pid) || env["CODEX_CLI_PATH"] != native {
		t.Fatalf("native identity=%v", env)
	}
}

func TestClassifyCodexInvocation(t *testing.T) {
	t.Parallel()
	if mode, err := classifyCodexInvocation([]string{"--version"}); err != nil || mode != bridgePassthrough {
		t.Fatalf("mode=%v err=%v", mode, err)
	}
	for _, args := range [][]string{{"app-server", "proxy"}, {"app-server", "--listen", "unix:///tmp/x"}} {
		if _, err := classifyCodexInvocation(args); err == nil {
			t.Fatalf("accepted %q", args)
		}
	}
}
