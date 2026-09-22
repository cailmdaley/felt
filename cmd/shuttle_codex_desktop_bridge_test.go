package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
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

func buildBridgeFakeNative(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fake-native")
	cmd := exec.Command("go", "build", "-tags", "bridge_test", "-o", path, "./testdata/codex_bridge")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build fake native: %v\n%s", err, out)
	}
	return path
}

func bridgeTestOptions(codex, socket string, stdin io.Reader, stdout io.Writer) bridgeOptions {
	return bridgeOptions{
		codex:   codex,
		socket:  socket,
		stdin:   stdin,
		stdout:  stdout,
		stderr:  io.Discard,
		args:    []string{"-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled", "-c", "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true"},
		startup: 2 * time.Second,
	}
}

func TestCodexDesktopBridgeRoundTripPreservesProcessBoundary(t *testing.T) {
	codex := buildBridgeFakeNative(t)
	dir := bridgeTempDir(t)
	socket := filepath.Join(dir, "private", "app-server.sock")
	argsFile := filepath.Join(dir, "args.json")
	envFile := filepath.Join(dir, "env.json")
	errorFile := filepath.Join(dir, "error.txt")
	t.Setenv("CODEX_CLI_PATH", "/wrapper/that/must/not/recurse")
	t.Setenv("CODEX_APP_TOOLS_PIPE_PATH", "/private/app-tools.pipe")
	t.Setenv("FELT_BRIDGE_ENV_MARKER", "preserve-me")
	t.Setenv("FELT_BRIDGE_SOCKET", socket)
	t.Setenv("FELT_BRIDGE_ARGS_FILE", argsFile)
	t.Setenv("FELT_BRIDGE_ENV_FILE", envFile)
	t.Setenv("FELT_BRIDGE_ERROR_FILE", errorFile)

	input := `{"id":1,"method":"large","params":{"blob":"` + strings.Repeat("x", 1<<20) + `"}}` + "\n"
	reader, writer := io.Pipe()
	output := &bridgeCapture{wrote: make(chan struct{})}
	o := bridgeTestOptions(codex, socket, reader, output)
	done := make(chan error, 1)
	go func() { done <- runCodexDesktopBridge(context.Background(), o) }()
	if _, err := writer.Write([]byte(input)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-output.wrote:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for websocket echo")
	}
	_ = writer.Close()
	if err := <-done; err != nil {
		if errorData, readErr := os.ReadFile(errorFile); readErr == nil {
			t.Logf("fake native error: %s", errorData)
		}
		t.Fatalf("bridge: %v", err)
	}
	if output.String() != strings.TrimSuffix(input, "\n")+"\n" {
		t.Fatalf("echoed output differs: got %d bytes, want %d", output.Len(), len(input))
	}
	var args []string
	bridgeReadJSONFile(t, argsFile, &args)
	wantPrefix := []string{"-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled", "-c", "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true"}
	if len(args) != len(wantPrefix)+2 {
		t.Fatalf("native args=%q", args)
	}
	for i, want := range wantPrefix {
		if args[i] != want {
			t.Fatalf("native arg %d=%q, want %q", i, args[i], want)
		}
	}
	if args[len(args)-2] != "--listen" || args[len(args)-1] != "unix://"+socket {
		t.Fatalf("bridge listen args=%q", args[len(args)-2:])
	}
	var env map[string]string
	bridgeReadJSONFile(t, envFile, &env)
	if env["CODEX_CLI_PATH"] != codex {
		t.Fatalf("native CODEX_CLI_PATH=%q, want %q", env["CODEX_CLI_PATH"], codex)
	}
	if env["CODEX_APP_TOOLS_PIPE_PATH"] != "/private/app-tools.pipe" || env["FELT_BRIDGE_ENV_MARKER"] != "preserve-me" {
		t.Fatalf("native environment was not preserved: %#v", env)
	}
	if _, err := os.Stat(socket); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("bridge socket remains after cleanup: %v", err)
	}
	if lock, err := os.ReadFile(socket + ".lock"); err != nil || len(lock) != 0 {
		t.Fatalf("owner metadata after cleanup=%q, err=%v", lock, err)
	}
}

func TestCodexDesktopBridgeRefusesPreexistingEndpoint(t *testing.T) {
	codex := buildBridgeFakeNative(t)
	dir := bridgeTempDir(t)
	socket := filepath.Join(dir, "private", "app-server.sock")
	if err := os.Mkdir(filepath.Dir(socket), 0700); err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if err := os.Chmod(socket, 0600); err != nil {
		t.Fatal(err)
	}
	o := bridgeTestOptions(codex, socket, strings.NewReader("{}\n"), io.Discard)
	if err := runCodexDesktopBridge(context.Background(), o); err == nil || !strings.Contains(err.Error(), "pre-existing") {
		t.Fatalf("error=%v, want pre-existing endpoint refusal", err)
	}
}

func TestCodexDesktopBridgeTimeoutCleansChildAndEndpoint(t *testing.T) {
	codex := buildBridgeFakeNative(t)
	dir := bridgeTempDir(t)
	socket := filepath.Join(dir, "private", "app-server.sock")
	t.Setenv("FELT_BRIDGE_NO_SOCKET", "1")
	o := bridgeTestOptions(codex, socket, strings.NewReader("{}\n"), io.Discard)
	o.startup = 100 * time.Millisecond
	if err := runCodexDesktopBridge(context.Background(), o); err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("error=%v, want startup timeout", err)
	}
	if _, err := os.Stat(socket); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket remains after timeout: %v", err)
	}
}

func TestCodexDesktopBridgeCancellationKillsPrivateChild(t *testing.T) {
	codex := buildBridgeFakeNative(t)
	dir := bridgeTempDir(t)
	socket := filepath.Join(dir, "private", "app-server.sock")
	envFile := filepath.Join(dir, "env.json")
	t.Setenv("FELT_BRIDGE_SOCKET", socket)
	t.Setenv("FELT_BRIDGE_ENV_FILE", envFile)
	reader, writer := io.Pipe()
	defer writer.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		o := bridgeTestOptions(codex, socket, reader, io.Discard)
		done <- runCodexDesktopBridge(ctx, o)
	}()
	waitForFile(t, envFile)
	var env map[string]string
	bridgeReadJSONFile(t, envFile, &env)
	pid, err := strconv.Atoi(env["FELT_BRIDGE_HELPER_PID"])
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("bridge did not stop after context cancellation")
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("native child pid %d still exists: %v", pid, err)
	}
}

func TestClassifyCodexInvocation(t *testing.T) {
	if mode, err := classifyCodexInvocation([]string{"--version"}); err != nil || mode != bridgePassthrough {
		t.Fatalf("version mode=%v, err=%v", mode, err)
	}
	if _, err := classifyCodexInvocation([]string{"app-server", "proxy"}); err == nil {
		t.Fatal("accepted raw app-server proxy")
	}
	if _, err := classifyCodexInvocation([]string{"app-server", "--listen", "unix:///tmp/x"}); err == nil {
		t.Fatal("accepted caller-supplied listen endpoint")
	}
}

func bridgeReadJSONFile(t *testing.T, path string, value any) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, value); err != nil {
		t.Fatal(err)
	}
}

func waitForFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", path)
}

func bridgeTempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "fdb-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

type bridgeCapture struct {
	bytes.Buffer
	wrote chan struct{}
}

func (w *bridgeCapture) Write(p []byte) (int, error) {
	n, err := w.Buffer.Write(p)
	select {
	case <-w.wrote:
	default:
		close(w.wrote)
	}
	return n, err
}
