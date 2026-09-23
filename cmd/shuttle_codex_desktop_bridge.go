//go:build !windows

package cmd

// The Codex desktop app speaks JSONL on its CODEX_CLI_PATH. Codex's
// app-server proxy speaks a websocket byte stream on stdio instead, so it is
// not a suitable wrapper. This command gives the desktop process the JSONL
// surface it expects while keeping the native app-server on a private Unix
// websocket endpoint.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/spf13/cobra"
)

const (
	bridgeStartupTimeout = 5 * time.Second
	bridgePollInterval   = 20 * time.Millisecond
	bridgeStopTimeout    = 5 * time.Second
	bridgeReadLimit      = 64 << 20
)

var (
	desktopBridgeCodex  string
	desktopBridgeSocket string
	desktopBridgeRelay  bool
)

var codexDesktopBridgeCmd = &cobra.Command{
	Use:          "codex-desktop-bridge --codex /absolute/path/to/codex -- [codex args...]",
	Short:        "Bridge Codex desktop JSONL to a private native app-server websocket",
	Args:         cobra.ArbitraryArgs,
	SilenceUsage: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		o := bridgeOptions{
			codex:  desktopBridgeCodex,
			socket: desktopBridgeSocket,
			stdin:  os.Stdin,
			stdout: os.Stdout,
			stderr: os.Stderr,
			args:   args,
		}
		if desktopBridgeRelay {
			return runCodexDesktopRelay(ctx, o)
		}
		return runCodexDesktopBridgeProcess(ctx, o)
	},
}

type bridgeOptions struct {
	codex, socket string
	stdin         io.Reader
	stdout        io.Writer
	stderr        io.Writer
	args          []string
	startup       time.Duration
}

func init() {
	codexDesktopBridgeCmd.Flags().StringVar(&desktopBridgeCodex, "codex", "", "Absolute path to the native Codex executable")
	codexDesktopBridgeCmd.Flags().StringVar(&desktopBridgeSocket, "socket", "", "Private Unix socket path (default: $CODEX_HOME/shuttle-desktop/app-server.sock)")
	codexDesktopBridgeCmd.Flags().BoolVar(&desktopBridgeRelay, "relay", false, "Internal relay process (used by the desktop bridge)")
	_ = codexDesktopBridgeCmd.Flags().MarkHidden("relay")
	shuttleCmd.AddCommand(codexDesktopBridgeCmd)
}

func normalizeBridgeOptions(o bridgeOptions) (bridgeOptions, error) {
	if o.stderr == nil {
		o.stderr = io.Discard
	}
	if o.stdin == nil {
		o.stdin = os.Stdin
	}
	if o.stdout == nil {
		o.stdout = os.Stdout
	}
	if o.codex == "" {
		return o, errors.New("--codex is required")
	}
	if !filepath.IsAbs(o.codex) {
		return o, fmt.Errorf("--codex must be an absolute path: %q", o.codex)
	}
	if info, err := os.Stat(o.codex); err != nil {
		return o, fmt.Errorf("stat native Codex %q: %w", o.codex, err)
	} else if info.IsDir() {
		return o, fmt.Errorf("native Codex path is a directory: %q", o.codex)
	}
	if o.startup <= 0 {
		o.startup = bridgeStartupTimeout
	}
	return o, nil
}

// runCodexDesktopBridgeProcess keeps the native executable in the desktop's
// original process slot. A child relay owns the socket and the desktop
// JSONL pipes; this preserves the signed Desktop -> Codex -> app-tools parent
// chain required by macOS peer authorization.
func runCodexDesktopBridgeProcess(ctx context.Context, raw bridgeOptions) error {
	o, err := normalizeBridgeOptions(raw)
	if err != nil {
		return err
	}
	mode, err := classifyCodexInvocation(o.args)
	if err != nil {
		return err
	}
	if mode == bridgePassthrough {
		return execNativePassthroughInPlace(o)
	}
	if err := configureCurrentBridgeProcess(); err != nil {
		return fmt.Errorf("isolate native Codex process group: %w", err)
	}
	socket, err := bridgeSocketPath(o.socket)
	if err != nil {
		return err
	}
	readyR, readyW, err := os.Pipe()
	if err != nil {
		return fmt.Errorf("create relay readiness pipe: %w", err)
	}
	defer readyR.Close()
	defer readyW.Close()
	self, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve bridge executable: %w", err)
	}
	relayArgs := []string{"shuttle", "codex-desktop-bridge", "--relay", "--codex", o.codex, "--socket", socket, "--"}
	relayArgs = append(relayArgs, o.args...)
	relay := exec.Command(self, relayArgs...)
	relay.Stdin, relay.Stdout, relay.Stderr = o.stdin, o.stdout, o.stderr
	relay.ExtraFiles = []*os.File{readyW}
	relay.Env = append(os.Environ(), "FELT_BRIDGE_READY_FD=3", fmt.Sprintf("FELT_BRIDGE_PARENT_PID=%d", os.Getpid()))
	if err := relay.Start(); err != nil {
		readyR.Close()
		readyW.Close()
		return fmt.Errorf("start bridge relay: %w", err)
	}
	readyW.Close()
	relayDone := make(chan struct{})
	var relayErr error
	go func() { relayErr = relay.Wait(); close(relayDone) }()
	ready := make(chan error, 1)
	go func() {
		data, readErr := io.ReadAll(io.LimitReader(readyR, 4096))
		readyR.Close()
		if readErr != nil {
			ready <- readErr
			return
		}
		if strings.HasPrefix(string(data), "READY\n") {
			ready <- nil
		} else {
			ready <- fmt.Errorf("relay refused startup: %s", strings.TrimSpace(string(data)))
		}
	}()
	startup := time.NewTimer(o.startup)
	defer startup.Stop()
	select {
	case <-startup.C:
		killUnstartedBridgeRelay(relay, relayDone)
		return errors.New("timed out waiting for bridge relay readiness")
	case err := <-ready:
		if err != nil {
			killUnstartedBridgeRelay(relay, relayDone)
			return err
		}
	case <-ctx.Done():
		killUnstartedBridgeRelay(relay, relayDone)
		return ctx.Err()
	case <-relayDone:
		return fmt.Errorf("bridge relay exited before startup: %w", relayErr)
	}
	if err := execNativeInPlace(o, socket); err != nil {
		killUnstartedBridgeRelay(relay, relayDone)
		return err
	}
	return nil
}

func execNativeInPlace(o bridgeOptions, socket string) error {
	args := append(append([]string(nil), o.args...), "--listen", "unix://"+socket)
	devNull, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("open native stdio sink: %w", err)
	}
	if err := syscall.Dup2(int(devNull.Fd()), 0); err != nil {
		devNull.Close()
		return fmt.Errorf("redirect native stdin: %w", err)
	}
	if err := syscall.Dup2(int(devNull.Fd()), 1); err != nil {
		devNull.Close()
		return fmt.Errorf("redirect native stdout: %w", err)
	}
	devNull.Close()
	if err := syscall.Exec(o.codex, append([]string{o.codex}, args...), bridgeChildEnvironment(o.codex)); err != nil {
		return fmt.Errorf("exec native Codex: %w", err)
	}
	return nil
}

func execNativePassthroughInPlace(o bridgeOptions) error {
	if err := syscall.Exec(o.codex, append([]string{o.codex}, o.args...), bridgeChildEnvironment(o.codex)); err != nil {
		return fmt.Errorf("exec native Codex: %w", err)
	}
	return nil
}

func runCodexDesktopRelay(ctx context.Context, raw bridgeOptions) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	o, err := normalizeBridgeOptions(raw)
	if err != nil {
		return err
	}
	readyFD, err := strconv.Atoi(os.Getenv("FELT_BRIDGE_READY_FD"))
	if err != nil || readyFD != 3 {
		return errors.New("relay readiness fd must be 3")
	}
	parentPID, err := strconv.Atoi(os.Getenv("FELT_BRIDGE_PARENT_PID"))
	if err != nil || parentPID <= 1 || os.Getppid() != parentPID || syscall.Getpgrp() != parentPID {
		return fmt.Errorf("relay parent pid: %q", os.Getenv("FELT_BRIDGE_PARENT_PID"))
	}
	socket, err := bridgeSocketPath(o.socket)
	if err != nil {
		return err
	}
	if err := prepareBridgeDirectory(filepath.Dir(socket)); err != nil {
		return err
	}
	owner, err := acquireBridgeOwner(socket)
	if err != nil {
		return err
	}
	defer owner.Close()
	if err := owner.recordNativePID(parentPID); err != nil {
		return err
	}
	if info, err := os.Lstat(socket); err == nil {
		return fmt.Errorf("refusing pre-existing bridge endpoint %q (%s)", socket, describeFile(info))
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("checking bridge endpoint %q: %w", socket, err)
	}
	ready := os.NewFile(uintptr(readyFD), "bridge-ready")
	if _, err := ready.WriteString("READY\n"); err != nil {
		return fmt.Errorf("signal relay readiness: %w", err)
	}
	_ = ready.Close()
	parentDone := make(chan struct{})
	go func() {
		for os.Getppid() == parentPID {
			time.Sleep(bridgePollInterval)
		}

		close(parentDone)
	}()
	endpoint, err := waitForBridgeEndpoint(ctx, socket, parentDone, func() error { return errors.New("native Codex parent exited") }, o.startup)
	if err != nil {
		fmt.Fprintln(o.stderr, err)
		return finishBridgeRelay(parentPID, parentDone, socket, endpoint, owner)
	}
	ws, err := dialBridgeSocket(ctx, socket)
	if err != nil {
		fmt.Fprintf(o.stderr, "connecting native Codex websocket: %v\n", err)
		return finishBridgeRelay(parentPID, parentDone, socket, endpoint, owner)
	}
	ws.SetReadLimit(bridgeReadLimit)
	relayDone := make(chan error, 1)
	go func() { relayDone <- relayBridgeJSONL(ctx, ws, o.stdin, o.stdout) }()
	select {
	case err = <-relayDone:
	case <-parentDone:
		cancel()
		_ = ws.Close()
		err = <-relayDone
	}
	_ = ws.Close()
	if err != nil && !errors.Is(err, context.Canceled) {
		fmt.Fprintln(o.stderr, err)
	}
	return finishBridgeRelay(parentPID, parentDone, socket, endpoint, owner)
}

type codexInvocationMode uint8

const (
	bridgeAppServer codexInvocationMode = iota
	bridgePassthrough
)

// classifyCodexInvocation deliberately only interprets the app-server shape.
// A wrapper may still be used for `codex --version`, help, and other native
// maintenance commands, which are passed through unchanged.
func classifyCodexInvocation(args []string) (codexInvocationMode, error) {
	appServer := -1
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "-c" || arg == "--config" {
			if i+1 >= len(args) {
				return 0, fmt.Errorf("%s requires a value", arg)
			}
			i++
			continue
		}
		if arg == "--listen" || strings.HasPrefix(arg, "--listen=") {
			return 0, errors.New("codex-desktop-bridge owns --listen; do not supply it")
		}
		if arg == "app-server" {
			if appServer >= 0 {
				return 0, errors.New("multiple app-server commands are not supported")
			}
			appServer = i
			continue
		}
		if appServer >= 0 && !strings.HasPrefix(arg, "-") {
			return 0, fmt.Errorf("unsupported app-server subcommand %q", arg)
		}
	}
	if appServer < 0 {
		return bridgePassthrough, nil
	}
	return bridgeAppServer, nil
}

func bridgeChildEnvironment(codex string) []string {
	env := os.Environ()
	filtered := make([]string, 0, len(env)+1)
	for _, entry := range env {
		if !strings.HasPrefix(entry, "CODEX_CLI_PATH=") {
			filtered = append(filtered, entry)
		}
	}
	// The desktop process points CODEX_CLI_PATH at this bridge. A native
	// backend must see the real executable or nested app-tools launches would
	// recursively enter the bridge.
	return append(filtered, "CODEX_CLI_PATH="+codex)
}

func bridgeSocketPath(explicit string) (string, error) {
	if explicit != "" {
		if !filepath.IsAbs(explicit) {
			return "", fmt.Errorf("--socket must be an absolute path: %q", explicit)
		}
		return filepath.Clean(explicit), nil
	}
	if configured := os.Getenv("SHUTTLE_CODEX_SOCKET"); configured != "" {
		if !filepath.IsAbs(configured) {
			return "", fmt.Errorf("SHUTTLE_CODEX_SOCKET must be an absolute path: %q", configured)
		}
		return filepath.Clean(configured), nil
	}
	home := os.Getenv("CODEX_HOME")
	if home == "" {
		var err error
		home, err = os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolving CODEX_HOME: %w", err)
		}
		home = filepath.Join(home, ".codex")
	}
	if !filepath.IsAbs(home) {
		return "", fmt.Errorf("CODEX_HOME must be an absolute path: %q", home)
	}
	return filepath.Join(home, "shuttle-desktop", "app-server.sock"), nil
}

type bridgeOwner struct {
	file   *os.File
	path   string
	socket string
}

func acquireBridgeOwner(socket string) (*bridgeOwner, error) {
	path := socket + ".lock"
	if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("refusing symlinked bridge owner lock %q", path)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("check bridge owner lock %q: %w", path, err)
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0600)
	if err != nil {
		return nil, fmt.Errorf("create bridge owner lock %q: %w", path, err)
	}
	cleanup := func() { f.Close() }
	info, err := f.Stat()
	if err != nil {
		cleanup()
		return nil, fmt.Errorf("stat bridge owner lock: %w", err)
	}
	if err := ensureOwnedPrivate(info, "bridge owner lock"); err != nil {
		cleanup()
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		cleanup()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, fmt.Errorf("another bridge already owns %q", socket)
		}
		return nil, fmt.Errorf("acquire bridge owner lock: %w", err)
	}
	if err = f.Truncate(0); err == nil {
		_, err = fmt.Fprintf(f, "relay_pid=%d\nsocket=%s\n", os.Getpid(), socket)
	}
	if err != nil {
		syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		cleanup()
		return nil, fmt.Errorf("write bridge owner lock: %w", err)
	}
	return &bridgeOwner{file: f, path: path, socket: socket}, nil
}

func (o *bridgeOwner) recordNativePID(pid int) error {
	if o == nil || o.file == nil {
		return errors.New("bridge owner is closed")
	}
	if _, err := o.file.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("seek bridge owner lock: %w", err)
	}
	if err := o.file.Truncate(0); err != nil {
		return fmt.Errorf("clear bridge owner lock: %w", err)
	}
	if _, err := fmt.Fprintf(o.file, "relay_pid=%d\nnative_pid=%d\nsocket=%s\n", os.Getpid(), pid, o.socket); err != nil {
		return fmt.Errorf("write bridge owner lock: %w", err)
	}
	return nil
}

func (o *bridgeOwner) Close() {
	if o == nil || o.file == nil {
		return
	}
	// Keep the inode stable: unlinking a flock file before releasing its fd
	// permits a concurrent owner to create a second inode and acquire it.
	// Clearing metadata leaves no stale owner claim while preserving locking.
	_ = o.file.Truncate(0)
	_ = syscall.Flock(int(o.file.Fd()), syscall.LOCK_UN)
	_ = o.file.Close()
	o.file = nil
}

func prepareBridgeDirectory(dir string) error {
	_, beforeErr := os.Lstat(dir)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("create bridge socket directory: %w", err)
	}
	if errors.Is(beforeErr, os.ErrNotExist) {
		if err := os.Chmod(dir, 0700); err != nil {
			return fmt.Errorf("secure new bridge socket directory: %w", err)
		}
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return fmt.Errorf("stat bridge socket directory: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("bridge socket directory is not a directory: %q", dir)
	}
	return ensureOwnedPrivate(info, "bridge socket directory")
}

func ensureOwnedPrivate(info os.FileInfo, what string) error {
	if !sameUser(info) {
		return fmt.Errorf("%s is not owned by the current user", what)
	}
	if info.Mode().Perm()&0077 != 0 {
		return fmt.Errorf("%s is accessible by another user (mode %04o)", what, info.Mode().Perm())
	}
	return nil
}

func waitForBridgeEndpoint(ctx context.Context, socket string, childDone <-chan struct{}, childError func() error, timeout time.Duration) (os.FileInfo, error) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	ticker := time.NewTicker(bridgePollInterval)
	defer ticker.Stop()
	for {
		if info, err := os.Lstat(socket); err == nil {
			if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() && info.Mode()&os.ModeSocket == 0 {
				return info, fmt.Errorf("bridge endpoint %q has unexpected type %s", socket, describeFile(info))
			}
			if info.Mode()&os.ModeSocket == 0 {
				return info, fmt.Errorf("bridge endpoint %q is not a Unix socket", socket)
			}
			if err := ensureOwnedPrivate(info, "bridge socket"); err != nil {
				return info, err
			}
			return info, nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("checking bridge endpoint: %w", err)
		}
		select {
		case <-childDone:
			err := childError()
			if err == nil {
				return nil, errors.New("native Codex exited before creating its websocket endpoint")
			}
			return nil, fmt.Errorf("native Codex exited before creating its websocket endpoint: %w", err)
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-timer.C:
			return nil, fmt.Errorf("timed out waiting for native Codex websocket endpoint %q", socket)
		case <-ticker.C:
		}
	}
}

func dialBridgeSocket(ctx context.Context, socket string) (*websocket.Conn, error) {
	dialer := websocket.Dialer{
		EnableCompression: false,
		HandshakeTimeout:  2 * time.Second,
		NetDialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		},
	}
	ws, _, err := dialer.DialContext(ctx, "ws://localhost/rpc", http.Header{"Host": []string{"localhost"}})
	return ws, err
}

type bridgeMessage struct {
	data []byte
	err  error
}

func relayBridgeJSONL(ctx context.Context, ws *websocket.Conn, stdin io.Reader, stdout io.Writer) (result error) {
	relayCtx, cancel := context.WithCancelCause(ctx)
	defer func() {
		cause := context.Cause(relayCtx)
		if errors.Is(cause, io.EOF) {
			result = nil
		} else if cause != nil && !errors.Is(cause, context.Canceled) {
			result = cause
		}
		cancel(nil)
	}()
	go func() {
		<-relayCtx.Done()
		_ = ws.Close()
	}()
	input := make(chan bridgeMessage, 1)
	go func() {
		// EOF or malformed input must also unblock an undrained desktop stdout.
		cancel(readBridgeInput(relayCtx, stdin, input))
	}()
	output := make(chan bridgeMessage, 1)
	go readBridgeOutput(relayCtx, ws, output)

	for {
		select {
		case <-relayCtx.Done():
			return relayCtx.Err()
		case msg := <-input:
			if msg.err != nil {
				if errors.Is(msg.err, io.EOF) {
					return nil
				}
				return fmt.Errorf("reading desktop stdin: %w", msg.err)
			}
			if err := ws.WriteMessage(websocket.TextMessage, msg.data); err != nil {
				return fmt.Errorf("writing native Codex websocket: %w", err)
			}
		case msg := <-output:
			if msg.err != nil {
				if websocket.IsCloseError(msg.err, websocket.CloseNormalClosure, websocket.CloseGoingAway) || errors.Is(msg.err, io.EOF) {
					return nil
				}
				return fmt.Errorf("reading native Codex websocket: %w", msg.err)
			}
			if err := writeBridgeOutput(relayCtx, stdout, append(msg.data, '\n')); err != nil {
				return fmt.Errorf("writing desktop stdout: %w", err)
			}
		}
	}
}

func writeBridgeOutput(ctx context.Context, stdout io.Writer, data []byte) error {
	done := make(chan error, 1)
	go func() {
		_, err := stdout.Write(data)
		done <- err
	}()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func readBridgeInput(ctx context.Context, r io.Reader, out chan<- bridgeMessage) error {
	br := bufio.NewReader(r)
	for {
		line, err := readBridgeRecord(br)
		if errors.Is(err, bufio.ErrBufferFull) {
			return errors.New("desktop stdin JSONL record exceeds 64 MiB")
		}
		if len(line) > 0 {
			line = bytes.TrimSuffix(line, []byte("\n"))
			line = bytes.TrimSuffix(line, []byte("\r"))
			if len(line) == 0 || !json.Valid(line) {
				return errors.New("desktop stdin contains a non-JSONL record")
			}
			sendBridgeMessage(ctx, out, bridgeMessage{data: append([]byte(nil), line...)})
		}
		if err != nil {
			if errors.Is(err, io.EOF) && len(line) > 0 {
				continue
			}
			return err
		}
	}
}

func readBridgeRecord(br *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		part, err := br.ReadSlice('\n')
		if len(line)+len(part) > bridgeReadLimit {
			return nil, bufio.ErrBufferFull
		}
		line = append(line, part...)
		if err == bufio.ErrBufferFull {
			continue
		}
		return line, err
	}
}

func readBridgeOutput(ctx context.Context, ws *websocket.Conn, out chan<- bridgeMessage) {
	for {
		kind, data, err := ws.ReadMessage()
		if err != nil {
			sendBridgeMessage(ctx, out, bridgeMessage{err: err})
			return
		}
		if kind != websocket.TextMessage && kind != websocket.BinaryMessage {
			continue
		}
		if !json.Valid(data) {
			sendBridgeMessage(ctx, out, bridgeMessage{err: errors.New("native Codex websocket returned a non-JSON message")})
			return
		}
		sendBridgeMessage(ctx, out, bridgeMessage{data: append([]byte(nil), data...)})
	}
}

func sendBridgeMessage(ctx context.Context, out chan<- bridgeMessage, msg bridgeMessage) {
	select {
	case out <- msg:
	case <-ctx.Done():
	}
}

// The native process has not been execed yet. Signaling the relay gracefully
// would make it shut down its parent (this process), so kill only the relay.
func killUnstartedBridgeRelay(child *exec.Cmd, done <-chan struct{}) {
	select {
	case <-done:
		return
	default:
	}
	_ = child.Process.Kill()
	select {
	case <-done:
	case <-time.After(bridgeStopTimeout):
	}
}

// The relay remains in the native private group, pinning its identity even
// after the native parent exits. Final group termination cannot target a reused
// group and also stops orphaned MCP descendants. Keep the lock held until exit.
func finishBridgeRelay(pid int, done <-chan struct{}, socket string, endpoint os.FileInfo, owner *bridgeOwner) error {
	if syscall.Getpgrp() != pid {
		return errors.New("bridge lost its private process group; endpoint left in place")
	}
	if stopBridgeParent(pid, done) {
		removeOwnedEndpoint(socket, endpoint)
		_ = owner.file.Truncate(0)
	}
	return signalBridgeProcessGroup(pid, syscall.SIGKILL)
}

func stopBridgeParent(pid int, done <-chan struct{}) bool {
	if os.Getppid() != pid {
		return true
	}
	_ = signalBridgeProcessGroup(pid, syscall.SIGTERM)
	timer := time.NewTimer(bridgeStopTimeout)
	defer timer.Stop()
	select {
	case <-done:
		return waitForBridgeParentReparent(pid)
	case <-timer.C:
	}
	if os.Getppid() != pid {
		return true
	}
	// Kill only the still-identical parent first, so the relay can confirm
	// exit and remove its endpoint before terminating its own entire group.
	_ = syscall.Kill(pid, syscall.SIGKILL)
	select {
	case <-done:
		return waitForBridgeParentReparent(pid)
	case <-time.After(bridgeStopTimeout):
		return false
	}
}

func waitForBridgeParentReparent(pid int) bool {
	deadline := time.Now().Add(bridgePollInterval * 10)
	for time.Now().Before(deadline) {
		if os.Getppid() != pid {
			return true
		}
		time.Sleep(bridgePollInterval)
	}
	return os.Getppid() != pid
}

func removeOwnedEndpoint(socket string, owned os.FileInfo) {
	if owned == nil {
		return
	}
	current, err := os.Lstat(socket)
	if err == nil && os.SameFile(owned, current) {
		_ = os.Remove(socket)
	}
}

func describeFile(info os.FileInfo) string {
	if info == nil {
		return "missing"
	}
	return info.Mode().String()
}
