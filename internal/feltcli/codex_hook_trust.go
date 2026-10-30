package feltcli

// Codex owns hook hashes and trust persistence. Felt only approves hooks whose
// pluginId identifies its own plugin, using the hashes returned by hooks/list,
// and only after the bytes Codex hashes are proven to be the promoted
// generation: trust is never laundered onto whatever sits in the cache.

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/codexendpoint"
	"github.com/gorilla/websocket"
)

// codexHookTrustMinimum is the oldest Codex verified to serve hooks/list with
// pluginId and split plugin hashes, and config/batchWrite.
const codexHookTrustMinimum = "0.166.0"

const defaultCodexTrustTimeout = 20 * time.Second

type codexTrustHook struct {
	Key         string `json:"key"`
	PluginID    string `json:"pluginId"`
	Source      string `json:"source"`
	SourcePath  string `json:"sourcePath"`
	CurrentHash string `json:"currentHash"`
	TrustStatus string `json:"trustStatus"`
}

// codexTrustState is the outcome of one trust inspection or refresh.
type codexTrustState string

const (
	// codex is not on PATH; there is nothing to trust.
	codexTrustAbsent codexTrustState = "absent"
	// Every felt hook is trusted wherever it was inspected.
	codexTrustTrusted codexTrustState = "trusted"
	// This Codex lacks the hook-trust API. Advisory: its TUI asks to review
	// felt's hooks instead.
	codexTrustUnsupported codexTrustState = "unsupported"
	// The bytes Codex hashes are not proven to be the promoted generation.
	// Nothing is written; the repair is a reinstall.
	codexTrustUnverified codexTrustState = "unverified"
	// Trust could not be listed, written or confirmed.
	codexTrustFailed codexTrustState = "failed"
)

// codexLiveState says what was learned about the shared App Server.
type codexLiveState string

const (
	codexLiveAbsent      codexLiveState = "absent"
	codexLiveVerified    codexLiveState = "verified"
	codexLiveUninspected codexLiveState = "uninspected"
)

type codexTrustReport struct {
	State          codexTrustState
	Err            error
	Live           codexLiveState
	LiveErr        error
	Endpoint       string
	EndpointSource string
}

// ReceiptCodexTrust is the hook component's account of Codex hook trust.
type ReceiptCodexTrust struct {
	State          codexTrustState `json:"state"`
	Live           codexLiveState  `json:"live,omitempty"`
	Endpoint       string          `json:"endpoint,omitempty"`
	EndpointSource string          `json:"endpoint_source,omitempty"`
	Note           string          `json:"note,omitempty"`
}

func (r codexTrustReport) receipt() *ReceiptCodexTrust {
	return &ReceiptCodexTrust{State: r.State, Live: r.Live, Endpoint: r.Endpoint, EndpointSource: r.EndpointSource, Note: r.note()}
}

// note describes advisory conditions and which live endpoint was inspected.
func (r codexTrustReport) note() string {
	var parts []string
	if r.State == codexTrustUnsupported {
		parts = append(parts, fmt.Sprintf("Codex lacks the hook-trust API (%v); upgrade Codex to ≥ %s so felt can trust its hooks, until then Codex asks to review them", r.Err, codexHookTrustMinimum))
	}
	switch r.Live {
	case codexLiveAbsent:
		parts = append(parts, fmt.Sprintf("no live Codex App Server at %s (from %s)", r.Endpoint, r.EndpointSource))
	case codexLiveVerified:
		parts = append(parts, fmt.Sprintf("live Codex App Server at %s (from %s) verified", r.Endpoint, r.EndpointSource))
	case codexLiveUninspected:
		parts = append(parts, fmt.Sprintf("live Codex App Server at %s (from %s) was not inspected (%v); trust was written and verified through a private App Server", r.Endpoint, r.EndpointSource, r.LiveErr))
	}
	return strings.Join(parts, "; ")
}

func (r codexTrustReport) repair() string {
	switch r.State {
	case codexTrustUnverified:
		return fmt.Sprintf("%v; run `felt setup codex` to reinstall felt's verified plugin, then rerun the receipt", r.Err)
	case codexTrustFailed:
		return fmt.Sprintf("%v; run `felt setup codex --trust-hooks`, then rerun the receipt", r.Err)
	}
	return ""
}

// errCodexTrustUnsupported marks a Codex that does not speak the trust API.
type errCodexTrustUnsupported struct{ reason string }

func (e *errCodexTrustUnsupported) Error() string { return e.reason }

func unsupported(format string, args ...any) error {
	return &errCodexTrustUnsupported{reason: fmt.Sprintf(format, args...)}
}

// errCodexTrustUnverified marks bytes not proven to be the promoted generation.
type errCodexTrustUnverified struct{ err error }

func (e *errCodexTrustUnverified) Error() string { return e.err.Error() }

// codexTrustRPC is one JSON-RPC session, over a private stdio server or the
// shared server's WebSocket. Every call is bounded by timeout.
type codexTrustRPC struct {
	cmd     *exec.Cmd
	input   io.WriteCloser
	frames  chan codexTrustFrame
	seq     int
	cancel  context.CancelFunc
	ws      *websocket.Conn
	timeout time.Duration
}

type codexTrustFrame struct {
	data json.RawMessage
	err  error
}

func (a *app) codexTrustTimeout() time.Duration {
	if a.trustTimeout > 0 {
		return a.trustTimeout
	}
	return defaultCodexTrustTimeout
}

func (a *app) openCodexTrustRPC() (*codexTrustRPC, error) {
	home, err := a.env.UserHomeDir()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	cmd := a.env.CommandContext(ctx, "codex", "app-server")
	// A neutral directory keeps the caller's project out of the answer.
	cmd.Dir = home
	input, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		input.Close()
		cancel()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		input.Close()
		cancel()
		return nil, err
	}
	r := &codexTrustRPC{cmd: cmd, input: input, frames: make(chan codexTrustFrame, 16), cancel: cancel, timeout: a.codexTrustTimeout()}
	go func() {
		decoder := json.NewDecoder(output)
		for {
			var frame json.RawMessage
			err := decoder.Decode(&frame)
			r.frames <- codexTrustFrame{frame, err}
			if err != nil {
				close(r.frames)
				return
			}
		}
	}()
	if err := r.initialize(); err != nil {
		r.close()
		return nil, err
	}
	return r, nil
}

func (a *app) openLiveCodexTrustRPC(socket string) (*codexTrustRPC, error) {
	ctx, cancel := context.WithTimeout(context.Background(), a.codexTrustTimeout())
	defer cancel()
	dialer := websocket.Dialer{NetDialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}
	conn, _, err := dialer.DialContext(ctx, "ws://localhost/", nil)
	if err != nil {
		return nil, err
	}
	conn.SetReadLimit(8 << 20)
	r := &codexTrustRPC{ws: conn, timeout: a.codexTrustTimeout()}
	if err := r.initialize(); err != nil {
		r.close()
		return nil, err
	}
	return r, nil
}

func (r *codexTrustRPC) initialize() error {
	var result json.RawMessage
	if err := r.call("initialize", map[string]any{"clientInfo": map[string]string{"name": "felt-setup", "version": "1"}, "capabilities": map[string]bool{"experimentalApi": true}}, &result); err != nil {
		return err
	}
	return r.send(map[string]any{"method": "initialized"})
}

func (r *codexTrustRPC) send(value any) error {
	if r.ws != nil {
		r.ws.SetWriteDeadline(time.Now().Add(r.timeout))
		return r.ws.WriteJSON(value)
	}
	return json.NewEncoder(r.input).Encode(value)
}

func (r *codexTrustRPC) close() {
	if r.ws != nil {
		r.ws.Close()
		return
	}
	r.input.Close()
	// Only this invocation's stdio server is owned here. The shared App
	// Server is reached over a client connection and is never stopped.
	r.cancel()
	_ = r.cmd.Wait()
}

// read returns the next frame, or an error once the call's deadline passes.
func (r *codexTrustRPC) read(deadline time.Time) (json.RawMessage, error) {
	if r.ws != nil {
		r.ws.SetReadDeadline(deadline)
		var frame json.RawMessage
		err := r.ws.ReadJSON(&frame)
		return frame, err
	}
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	select {
	case frame, ok := <-r.frames:
		if !ok {
			return nil, io.EOF
		}
		return frame.data, frame.err
	case <-timer.C:
		return nil, fmt.Errorf("no answer within %s", r.timeout)
	}
}

func (r *codexTrustRPC) call(method string, params, result any) error {
	r.seq++
	if err := r.send(map[string]any{"id": r.seq, "method": method, "params": params}); err != nil {
		return fmt.Errorf("codex %s: %w", method, err)
	}
	deadline := time.Now().Add(r.timeout)
	for frames := 0; frames < 256; frames++ {
		var response struct {
			ID     int             `json:"id"`
			Method string          `json:"method"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		frame, err := r.read(deadline)
		if err != nil {
			return fmt.Errorf("codex %s: %w", method, err)
		}
		if err := json.Unmarshal(frame, &response); err != nil {
			return fmt.Errorf("codex %s: %w", method, err)
		}
		if response.Method != "" || response.ID != r.seq {
			continue
		}
		if response.Error != nil {
			// Codex answers a method it does not know with "unknown variant".
			if response.Error.Code == -32601 || (response.Error.Code == -32600 && strings.Contains(response.Error.Message, "unknown variant")) {
				return unsupported("codex does not serve %s", method)
			}
			return fmt.Errorf("codex %s: %s (code %d)", method, response.Error.Message, response.Error.Code)
		}
		if len(response.Result) == 0 || string(response.Result) == "null" {
			return fmt.Errorf("codex %s: missing result", method)
		}
		if err := json.Unmarshal(response.Result, result); err != nil {
			return unsupported("codex %s answered in an unknown shape: %v", method, err)
		}
		return nil
	}
	return fmt.Errorf("codex %s: too many unrelated responses", method)
}

func (a *app) listFeltCodexHooks(r *codexTrustRPC) ([]codexTrustHook, error) {
	home, err := a.env.UserHomeDir()
	if err != nil {
		return nil, err
	}
	var result struct {
		Data *[]struct {
			Hooks  []codexTrustHook `json:"hooks"`
			Errors []struct {
				Message string `json:"message"`
			} `json:"errors"`
		} `json:"data"`
	}
	// Plugin hooks are global; asking from $HOME keeps the answer
	// independent of where setup runs.
	if err := r.call("hooks/list", map[string]any{"cwds": []string{home}}, &result); err != nil {
		return nil, err
	}
	if result.Data == nil {
		return nil, unsupported("codex hooks/list answered without data")
	}
	var hooks []codexTrustHook
	for _, entry := range *result.Data {
		// Incomplete discovery must not be mistaken for a fully trusted install.
		if len(entry.Errors) > 0 {
			return nil, fmt.Errorf("codex hooks/list: %s", entry.Errors[0].Message)
		}
		for _, h := range entry.Hooks {
			if h.PluginID == "" && strings.HasPrefix(h.Key, codexPluginRef+":") {
				return nil, unsupported("codex hooks/list reports felt hook %s without a pluginId", h.Key)
			}
			if h.PluginID != codexPluginRef {
				continue
			}
			if h.Source != "plugin" || !strings.HasPrefix(h.Key, codexPluginRef+":") {
				return nil, fmt.Errorf("codex hooks/list: inconsistent felt hook identity %q", h.Key)
			}
			if h.TrustStatus == "" {
				return nil, unsupported("codex hooks/list reports felt hook %s without a trustStatus", h.Key)
			}
			if _, _, err := codexTrustHashes(h.CurrentHash); err != nil {
				return nil, err
			}
			hooks = append(hooks, h)
		}
	}
	return hooks, nil
}

func codexTrustHashes(hash string) (string, string, error) {
	definition, content, ok := strings.Cut(hash, "/")
	for _, part := range []string{definition, content} {
		digest, hasPrefix := strings.CutPrefix(part, "sha256:")
		decoded, err := hex.DecodeString(digest)
		if !ok || !hasPrefix || err != nil || len(decoded) != 32 {
			return "", "", unsupported("unsupported Codex plugin hook hash %q", hash)
		}
	}
	return definition, content, nil
}

func requireFeltCodexTrust(hooks []codexTrustHook) error {
	if len(hooks) == 0 {
		return fmt.Errorf("codex hooks/list: no hooks for %s", codexPluginRef)
	}
	for _, h := range hooks {
		if h.TrustStatus != "trusted" && h.TrustStatus != "managed" {
			return fmt.Errorf("felt Codex hook %s is %s", h.Key, h.TrustStatus)
		}
	}
	return nil
}

func (a *app) codexHome() (string, error) {
	if home := a.env.Getenv("CODEX_HOME"); home != "" {
		return a.env.Abs(home)
	}
	return a.homePath(".codex")
}

// verifiedCodexCacheRoot proves that Codex's plugin cache holds the active
// promoted generation and returns its resolved path. `codex plugin list`
// reports the marketplace source rather than the cache Codex loads and
// hashes, so the cache is located from Codex's layout and its sealed marker
// and payload digest are checked directly.
func (a *app) verifiedCodexCacheRoot() (string, error) {
	runtimeDir, err := a.pluginRuntimeDir()
	if err != nil {
		return "", err
	}
	current := filepath.Join(runtimeDir, pluginCurrentName)
	expected, present, err := promotedGenerationForVerify(current)
	if err != nil {
		return "", err
	}
	if !present {
		return "", fmt.Errorf("the promoted plugin at %s carries no %s marker", filepath.Join(current, "claude-plugin"), pluginGenerationMarkerName)
	}
	codexHome, err := a.codexHome()
	if err != nil {
		return "", err
	}
	cache := filepath.Join(codexHome, "plugins", "cache", marketplaceName, "felt", expected.PluginVersion)
	if err := verifyLoadedGeneration("codex", expected, cache); err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(cache)
}

// requireHooksUnder rejects any felt hook Codex loads from outside root.
func requireHooksUnder(hooks []codexTrustHook, root string) error {
	for _, h := range hooks {
		path, err := filepath.EvalSymlinks(h.SourcePath)
		if err != nil {
			return fmt.Errorf("felt Codex hook %s: source %q: %w", h.Key, h.SourcePath, err)
		}
		if rel, err := filepath.Rel(root, path); err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return fmt.Errorf("felt Codex hook %s loads from %s, outside the verified cache %s", h.Key, path, root)
		}
	}
	return nil
}

// codexEndpoint names the shared App Server socket and where the name came
// from: SHUTTLE_CODEX_SOCKET, else the endpoint the running local Shuttle
// daemon reports, else the default resolution.
func (a *app) codexEndpoint() (string, string, error) {
	if override := a.env.Getenv("SHUTTLE_CODEX_SOCKET"); override != "" {
		socket, err := codexendpoint.Resolve(override, a.env.EUID(), "")
		return socket, "SHUTTLE_CODEX_SOCKET", err
	}
	if socket := a.daemonCodexEndpoint(); socket != "" {
		return socket, "shuttle daemon", nil
	}
	hostname, err := a.env.Hostname()
	if err != nil {
		return "", "default", err
	}
	socket, err := codexendpoint.Resolve("", a.env.EUID(), hostname)
	return socket, "default", err
}

// daemonCodexEndpoint asks the running local daemon, through `shuttle
// version --json`, which Codex endpoint it uses. Any failure is no answer.
func (a *app) daemonCodexEndpoint() string {
	shuttle, err := a.env.LookPath("shuttle")
	if err != nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), a.probeTimeout)
	defer cancel()
	out, err := a.env.CommandContext(ctx, shuttle, "version", "--json").Output()
	if err != nil {
		return ""
	}
	var version struct {
		CodexBackend struct {
			Endpoint string `json:"endpoint"`
		} `json:"codex_backend"`
	}
	if json.Unmarshal(out, &version) != nil || !filepath.IsAbs(version.CodexBackend.Endpoint) {
		return ""
	}
	return filepath.Clean(version.CodexBackend.Endpoint)
}

// codexVersionTooOld reports a `codex --version` that parses and is below
// the minimum. An unparseable answer defers to the protocol's own shape.
func (a *app) codexVersionTooOld() (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), a.probeTimeout)
	defer cancel()
	out, err := a.env.CommandContext(ctx, "codex", "--version").Output()
	if err != nil {
		return "", false
	}
	fields := strings.Fields(string(out))
	if len(fields) == 0 {
		return "", false
	}
	version := fields[len(fields)-1]
	got, ok := parseDottedVersion(version)
	if !ok {
		return version, false
	}
	want, _ := parseDottedVersion(codexHookTrustMinimum)
	for i := range want {
		if got[i] != want[i] {
			return version, got[i] < want[i]
		}
	}
	return version, false
}

func parseDottedVersion(version string) ([3]int, bool) {
	version, _, _ = strings.Cut(strings.TrimPrefix(version, "v"), "-")
	parts := strings.Split(version, ".")
	var out [3]int
	if len(parts) != 3 {
		return out, false
	}
	for i, part := range parts {
		n, err := strconv.Atoi(part)
		if err != nil {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

// codexHookTrust lists before any write and verifies afterwards. It also
// serves the read-only receipt path, which must detect stale persisted hashes.
func (a *app) codexHookTrust(write bool) codexTrustReport {
	var report codexTrustReport
	if _, err := a.env.LookPath("codex"); err != nil {
		report.State = codexTrustAbsent
		return report
	}
	err := a.inspectCodexHookTrust(write, &report)
	var unsupportedErr *errCodexTrustUnsupported
	var unverifiedErr *errCodexTrustUnverified
	switch {
	case err == nil:
		report.State = codexTrustTrusted
	case errors.As(err, &unsupportedErr):
		report.State, report.Err = codexTrustUnsupported, err
	case errors.As(err, &unverifiedErr):
		report.State, report.Err = codexTrustUnverified, err
	default:
		report.State, report.Err = codexTrustFailed, err
	}
	return report
}

func (a *app) inspectCodexHookTrust(write bool, report *codexTrustReport) error {
	if version, old := a.codexVersionTooOld(); old {
		return unsupported("codex %s predates %s", version, codexHookTrustMinimum)
	}
	cacheRoot, err := a.verifiedCodexCacheRoot()
	if err != nil {
		return &errCodexTrustUnverified{err}
	}
	r, err := a.openCodexTrustRPC()
	if err != nil {
		return err
	}
	defer r.close()
	hooks, err := a.listFeltCodexHooks(r)
	if err != nil {
		return err
	}
	if len(hooks) == 0 {
		return fmt.Errorf("codex hooks/list: no hooks for %s", codexPluginRef)
	}
	if err := requireHooksUnder(hooks, cacheRoot); err != nil {
		return &errCodexTrustUnverified{err}
	}

	live, err := a.liveCodexTrustRPC(report)
	if err != nil {
		return err
	}
	var liveHooks []codexTrustHook
	if live != nil {
		defer live.close()
		if liveHooks, err = a.listFeltCodexHooks(live); err != nil {
			return fmt.Errorf("live Codex trust inspection: %w", err)
		}
	}
	if write {
		refreshLive := live != nil && compareCodexTrust(hooks, liveHooks) != nil
		var edits []map[string]any
		for _, h := range hooks {
			if h.TrustStatus == "managed" || (h.TrustStatus == "trusted" && !refreshLive) {
				continue
			}
			definition, content, err := codexTrustHashes(h.CurrentHash)
			if err != nil {
				return err
			}
			// A JSON-quoted string is also a TOML basic quoted key. Quoting the
			// entire hook key keeps dots and colons out of the key-path grammar.
			key, _ := json.Marshal(h.Key)
			edits = append(edits, map[string]any{"keyPath": "hooks.state." + string(key), "value": map[string]string{"trusted_hash": definition, "trusted_content_hash": content}, "mergeStrategy": "upsert"})
		}
		if len(edits) > 0 {
			writer := r
			if live != nil {
				writer = live
			}
			// A live server can have a different CODEX_HOME. Name this
			// invocation's config explicitly, never its implicit default.
			codexHome, err := a.codexHome()
			if err != nil {
				return err
			}
			var result struct {
				Status string `json:"status"`
			}
			if err := writer.call("config/batchWrite", map[string]any{"edits": edits, "reloadUserConfig": true, "filePath": filepath.Join(codexHome, "config.toml")}, &result); err != nil {
				return err
			}
			if result.Status == "" {
				return unsupported("codex config/batchWrite answered without a status")
			}
			if result.Status != "ok" {
				return fmt.Errorf("codex config/batchWrite: status %q", result.Status)
			}
			if hooks, err = a.listFeltCodexHooks(r); err != nil {
				return err
			}
		}
	}
	if err := requireFeltCodexTrust(hooks); err != nil {
		return err
	}
	if live != nil {
		if liveHooks, err = a.listFeltCodexHooks(live); err != nil {
			return fmt.Errorf("live Codex trust inspection: %w", err)
		}
		if err := compareCodexTrust(hooks, liveHooks); err != nil {
			return err
		}
		report.Live = codexLiveVerified
	}
	return nil
}

// liveCodexTrustRPC connects to the shared App Server. An absent socket means
// there is no viewer runtime to check. A socket that refuses, stalls or fails
// the handshake leaves the live server uninspected while the private server
// still writes and verifies; the shared server is never replaced.
func (a *app) liveCodexTrustRPC(report *codexTrustReport) (*codexTrustRPC, error) {
	socket, source, err := a.codexEndpoint()
	report.Endpoint, report.EndpointSource = socket, source
	if err != nil {
		return nil, err
	}
	if _, err := os.Lstat(socket); os.IsNotExist(err) {
		report.Live = codexLiveAbsent
		return nil, nil
	}
	r, err := a.openLiveCodexTrustRPC(socket)
	if err != nil {
		report.Live, report.LiveErr = codexLiveUninspected, err
		return nil, nil
	}
	return r, nil
}

func compareCodexTrust(current, live []codexTrustHook) error {
	if len(current) != len(live) {
		return fmt.Errorf("live Codex reports a different felt hook set")
	}
	byKey := make(map[string]codexTrustHook, len(current))
	for _, h := range current {
		byKey[h.Key] = h
	}
	for _, h := range live {
		want, ok := byKey[h.Key]
		if !ok || want.CurrentHash != h.CurrentHash || want.SourcePath != h.SourcePath {
			return fmt.Errorf("live Codex has a different definition, payload or source for felt hook %s", h.Key)
		}
	}
	if err := requireFeltCodexTrust(live); err != nil {
		return fmt.Errorf("live Codex: %w", err)
	}
	return nil
}

// refreshCodexHookTrust is setup's trust step; it warns and never fails setup.
func (a *app) refreshCodexHookTrust() {
	report := a.codexHookTrust(true)
	switch report.State {
	case codexTrustAbsent:
	case codexTrustTrusted:
		fmt.Fprintln(a.env.Stdout, "✓ Codex trusts felt's plugin hooks")
		if report.Live == codexLiveUninspected {
			fmt.Fprintf(a.env.Stderr, "Note: %s.\n", report.note())
		}
	case codexTrustUnsupported:
		fmt.Fprintf(a.env.Stderr, "Warning: %s.\n", report.note())
	default:
		fmt.Fprintf(a.env.Stderr, "Warning: felt's Codex hooks could not be trusted: %s\n", report.repair())
	}
}

// trustCodexHooks is `felt setup codex --trust-hooks`.
func (a *app) trustCodexHooks() error {
	if _, err := a.env.LookPath("codex"); err != nil {
		return fmt.Errorf("--trust-hooks needs the codex CLI on PATH: %w", err)
	}
	return a.withPluginPromotionLock(func() error {
		report := a.codexHookTrust(true)
		switch report.State {
		case codexTrustTrusted:
			fmt.Fprintln(a.env.Stdout, "✓ Codex trusts felt's plugin hooks")
			fmt.Fprintf(a.env.Stderr, "Note: %s.\n", report.note())
			return nil
		case codexTrustUnsupported:
			return errors.New(report.note())
		default:
			return errors.New(report.repair())
		}
	})
}
