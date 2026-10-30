package feltcli

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
	"github.com/gorilla/websocket"
)

// fakeTrustServer models the slice of the Codex App Server that trust uses.
// Hook definitions are per server (a live server can hold an older view);
// persisted trust is one store shared by every server, as config.toml is.
type fakeTrustServer struct {
	hooks string // {"data":[{"hooks":[...]}]}
	store string // {"<key>": "<definition>/<content>"}
	log   string
	fail  string
	mu    *sync.Mutex
}

func (s fakeTrustServer) handle(line []byte) []byte {
	if s.mu != nil {
		s.mu.Lock()
		defer s.mu.Unlock()
	}
	var req struct {
		ID     int             `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	line = bytes.TrimSpace(line)
	if err := json.Unmarshal(line, &req); err != nil {
		panic(err)
	}
	if log, err := os.OpenFile(s.log, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600); err == nil {
		fmt.Fprintln(log, string(line))
		log.Close()
	}
	if req.Method == "initialized" {
		return nil
	}
	store := map[string]string{}
	if data, err := os.ReadFile(s.store); err == nil {
		json.Unmarshal(data, &store)
	}
	var result any = map[string]any{}
	var rpcError any
	switch req.Method {
	case "hooks/list":
		var state struct {
			Data []struct {
				Hooks []codexTrustHook `json:"hooks"`
			} `json:"data"`
		}
		data, _ := os.ReadFile(s.hooks)
		json.Unmarshal(data, &state)
		var out []map[string]any
		for _, entry := range state.Data {
			var hooks []map[string]any
			for _, h := range entry.Hooks {
				if h.TrustStatus != "managed" && store[h.Key] == h.CurrentHash {
					h.TrustStatus = "trusted"
				}
				m := map[string]any{"key": h.Key, "pluginId": h.PluginID, "source": h.Source, "sourcePath": h.SourcePath, "currentHash": h.CurrentHash, "trustStatus": h.TrustStatus}
				if s.fail == "no-plugin-id" {
					delete(m, "pluginId")
				}
				hooks = append(hooks, m)
			}
			out = append(out, map[string]any{"hooks": hooks, "errors": []any{}})
		}
		result = map[string]any{"data": out}
		switch s.fail {
		case "list":
			rpcError = map[string]any{"code": -1, "message": "list refused"}
		case "old-method":
			rpcError = map[string]any{"code": -32600, "message": "Invalid request: unknown variant `hooks/list`, expected one of `initialize`"}
		case "no-data":
			result = map[string]any{"hooks": out}
		}
	case "config/batchWrite":
		switch s.fail {
		case "write":
			rpcError = map[string]any{"code": -1, "message": "write refused"}
		case "old-write":
			rpcError = map[string]any{"code": -32601, "message": "method not found"}
		}
		if rpcError != nil {
			break
		}
		var request struct {
			Edits []struct {
				KeyPath string            `json:"keyPath"`
				Value   map[string]string `json:"value"`
			} `json:"edits"`
		}
		json.Unmarshal(req.Params, &request)
		for _, edit := range request.Edits {
			var key string
			if json.Unmarshal([]byte(strings.TrimPrefix(edit.KeyPath, "hooks.state.")), &key) != nil || s.fail == "verify" {
				continue
			}
			store[key] = edit.Value["trusted_hash"] + "/" + edit.Value["trusted_content_hash"]
		}
		data, _ := json.Marshal(store)
		if err := os.WriteFile(s.store, data, 0600); err != nil {
			panic(err)
		}
		result = map[string]any{"status": "ok"}
	}
	response := map[string]any{"id": req.ID, "result": result}
	if rpcError != nil {
		delete(response, "result")
		response["error"] = rpcError
	}
	data, _ := json.Marshal(response)
	return data
}

// The stdio fake is this test binary behind a LinkScript launcher.
func TestCodexTrustRPCProcess(t *testing.T) {
	if os.Getenv("FELT_TRUST_RPC_HELPER") != "1" {
		return
	}
	server := fakeTrustServer{hooks: os.Getenv("TRUST_HOOKS"), store: os.Getenv("TRUST_STORE"), log: os.Getenv("TRUST_LOG"), fail: os.Getenv("TRUST_FAIL")}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	for scanner.Scan() {
		if response := server.handle(scanner.Bytes()); response != nil {
			fmt.Fprintln(os.Stdout, string(response))
		}
	}
	os.Exit(0)
}

type trustFake struct {
	env   *sysenv.Env
	dir   string
	cache string
	stdio fakeTrustServer
}

func writeTrustHooks(t *testing.T, path string, hooks []codexTrustHook) {
	t.Helper()
	data, err := json.Marshal(map[string]any{"data": []any{map[string]any{"hooks": hooks}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
}

// sealedCodexCache promotes a sealed generation and gives Codex's cache the
// same bytes, as a verified install leaves them.
func sealedCodexCache(t *testing.T, env *sysenv.Env) string {
	t.Helper()
	home := homeOf(t, env)
	current := filepath.Join(home, ".felt", pluginRuntimeDirName, pluginCurrentName)
	plugin := filepath.Join(current, "claude-plugin")
	for path, content := range map[string]string{
		".claude-plugin/plugin.json": `{"name":"felt","version":"9.9.9"}`,
		"hooks/hooks.json":           `{"hooks":{}}`,
	} {
		path = filepath.Join(plugin, path)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	digest, err := pluginPayloadDigest(plugin)
	if err != nil {
		t.Fatal(err)
	}
	identity := pluginGenerationIdentity{Schema: 1, SourceKind: "local", Source: "/example/felt", PluginVersion: "9.9.9", FeltBuild: "test", PayloadSHA256: digest}
	if err := sealPluginGeneration(current, identity); err != nil {
		t.Fatal(err)
	}
	cache := filepath.Join(home, ".codex", "plugins", "cache", marketplaceName, "felt", "9.9.9")
	if err := copyTree(plugin, cache); err != nil {
		t.Fatal(err)
	}
	resolved, err := filepath.EvalSymlinks(cache)
	if err != nil {
		t.Fatal(err)
	}
	return resolved
}

func fakeCodexTrust(t *testing.T, env *sysenv.Env, hooks []codexTrustHook) *trustFake {
	t.Helper()
	f := &trustFake{env: env, dir: t.TempDir(), cache: sealedCodexCache(t, env)}
	f.stdio = fakeTrustServer{hooks: filepath.Join(f.dir, "hooks.json"), store: filepath.Join(f.dir, "store.json"), log: filepath.Join(f.dir, "log")}
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	env.Set("FELT_TRUST_RPC_HELPER", "1")
	env.Set("TRUST_TEST_BINARY", binary)
	env.Set("TRUST_LOG", f.stdio.log)
	env.Set("TRUST_HOOKS", f.stdio.hooks)
	env.Set("TRUST_STORE", f.stdio.store)
	f.setHooks(t, f.stdio.hooks, hooks)
	sysenvtest.FakeCommand(t, env, "codex", `case "$1" in
--version) echo "codex-cli ${TRUST_CODEX_VERSION:-0.166.0}" ;;
app-server) exec "$TRUST_TEST_BINARY" '-test.run=^TestCodexTrustRPCProcess$' ;;
*) exit 0 ;;
esac
`)
	return f
}

// setHooks places hooks without a source in the verified cache. Hooks
// already "trusted" are recorded in the shared store.
func (f *trustFake) setHooks(t *testing.T, path string, hooks []codexTrustHook) {
	t.Helper()
	store := map[string]string{}
	if data, err := os.ReadFile(f.stdio.store); err == nil {
		json.Unmarshal(data, &store)
	}
	for i := range hooks {
		if hooks[i].SourcePath == "" {
			hooks[i].SourcePath = filepath.Join(f.cache, "hooks", "hooks.json")
		}
		if hooks[i].TrustStatus == "trusted" {
			store[hooks[i].Key] = hooks[i].CurrentHash
		}
	}
	writeTrustHooks(t, path, hooks)
	data, _ := json.Marshal(store)
	if err := os.WriteFile(f.stdio.store, data, 0600); err != nil {
		t.Fatal(err)
	}
}

func (f *trustFake) fail(mode string) { f.env.Set("TRUST_FAIL", mode) }

func readTrustLog(t *testing.T, path string) []map[string]json.RawMessage {
	t.Helper()
	data, _ := os.ReadFile(path)
	var requests []map[string]json.RawMessage
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	for scanner.Scan() {
		var req map[string]json.RawMessage
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			t.Fatal(err)
		}
		requests = append(requests, req)
	}
	return requests
}

func (f *trustFake) requests(t *testing.T) []map[string]json.RawMessage {
	return readTrustLog(t, f.stdio.log)
}

func countMethod(requests []map[string]json.RawMessage, method string) int {
	n := 0
	for _, req := range requests {
		if string(req["method"]) == `"`+method+`"` {
			n++
		}
	}
	return n
}

// liveMode selects how the fake shared App Server behaves.
type liveMode string

const (
	liveAnswers liveMode = "answers"
	liveHangs   liveMode = "hangs"
	liveStale   liveMode = "stale"
)

// fakeLiveCodex serves the fake over a Unix-socket WebSocket, the transport
// the shared App Server speaks. hooks nil shares the stdio server's view.
func (f *trustFake) fakeLiveCodex(t *testing.T, mode liveMode, hooks []codexTrustHook) (string, fakeTrustServer) {
	t.Helper()
	// Unix socket paths are short; t.TempDir is too long on macOS.
	dir, err := os.MkdirTemp("/tmp", "fht-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socket := filepath.Join(dir, "app.sock")
	live := f.stdio
	live.log = filepath.Join(f.dir, "live.log")
	live.fail = f.env.Getenv("TRUST_FAIL")
	live.mu = &sync.Mutex{}
	if hooks != nil {
		live.hooks = filepath.Join(f.dir, "live-hooks.json")
		f.setHooks(t, live.hooks, hooks)
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	if mode == liveStale {
		// A crashed server leaves its socket file behind; dials are refused.
		listener.(*net.UnixListener).SetUnlinkOnClose(false)
		listener.Close()
		return socket, live
	}
	upgrader := websocket.Upgrader{}
	done := make(chan struct{})
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			_, message, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if mode == liveHangs {
				continue
			}
			if response := live.handle(message); response != nil {
				if conn.WriteMessage(websocket.TextMessage, response) != nil {
					return
				}
			}
		}
	})}
	go func() { server.Serve(listener); close(done) }()
	t.Cleanup(func() { server.Close(); <-done })
	return socket, live
}

func trustHook(plugin, key, status string) codexTrustHook {
	return codexTrustHook{PluginID: plugin, Key: key, Source: "plugin", CurrentHash: "sha256:" + strings.Repeat("a", 64) + "/sha256:" + strings.Repeat("b", 64), TrustStatus: status}
}

func feltHook(event, status string) codexTrustHook {
	return trustHook(codexPluginRef, codexPluginRef+":hooks/hooks.json:"+event+":0:0", status)
}

// Negative control: remove the pluginId filter; the request assertion catches
// approval of another plugin and the before/after state check catches mutation.
func TestCodexHookTrustOnlyWritesFeltAndIsIdempotent(t *testing.T) {
	t.Parallel()
	env, _ := testEnv(t)
	felt := feltHook("session_start", "modified")
	other := trustHook("another@market", "another@market:hooks/hooks.json:0:0", "untrusted")
	user := trustHook("", "user:/hooks.json:0:0", "untrusted")
	user.Source = "user"
	project := user
	project.Key = "project:/hooks.json:0:0"
	project.Source = "project"
	// A felt-looking key without felt's pluginId is never authority to approve.
	impostor := other
	impostor.Key = codexPluginRef + ":hooks/hooks.json:stop:9:9"
	f := fakeCodexTrust(t, env, []codexTrustHook{felt, other, user, project, impostor})
	a := testApp(t, env)
	for range 2 {
		if r := a.codexHookTrust(true); r.State != codexTrustTrusted || r.Live != codexLiveAbsent {
			t.Fatalf("trust = %+v", r)
		}
	}
	writes, lists := 0, 0
	for _, req := range f.requests(t) {
		var method string
		json.Unmarshal(req["method"], &method)
		if method == "hooks/list" {
			lists++
			var params struct {
				Cwds []string `json:"cwds"`
			}
			json.Unmarshal(req["params"], &params)
			if len(params.Cwds) != 1 || params.Cwds[0] != homeOf(t, env) {
				t.Fatalf("hooks/list not asked from $HOME: %s", req["params"])
			}
		}
		if method != "config/batchWrite" {
			continue
		}
		writes++
		if lists != 1 {
			t.Fatalf("write preceded by %d lists", lists)
		}
		var params struct {
			Edits []struct {
				KeyPath string            `json:"keyPath"`
				Value   map[string]string `json:"value"`
				Merge   string            `json:"mergeStrategy"`
			} `json:"edits"`
			Reload bool   `json:"reloadUserConfig"`
			File   string `json:"filePath"`
		}
		if err := json.Unmarshal(req["params"], &params); err != nil {
			t.Fatal(err)
		}
		if len(params.Edits) != 1 || params.Edits[0].KeyPath != `hooks.state."`+felt.Key+`"` || !params.Reload || params.File != filepath.Join(homeOf(t, env), ".codex", "config.toml") {
			t.Fatalf("unsafe trust params: %s", req["params"])
		}
		edit := params.Edits[0]
		if edit.Merge != "upsert" || edit.Value["trusted_hash"] != "sha256:"+strings.Repeat("a", 64) || edit.Value["trusted_content_hash"] != "sha256:"+strings.Repeat("b", 64) {
			t.Fatalf("hashes not copied from Codex: %#v", edit)
		}
	}
	if writes != 1 || lists != 3 {
		t.Fatalf("writes=%d lists=%d", writes, lists)
	}
	data, _ := os.ReadFile(f.stdio.store)
	var store map[string]string
	json.Unmarshal(data, &store)
	if len(store) != 1 || store[felt.Key] == "" {
		t.Fatalf("trust store holds more than felt's hook: %v", store)
	}
}

func TestCodexHookTrustFailuresWarnAndReceiptRejects(t *testing.T) {
	for _, failure := range []string{"write", "list", "verify", "missing", "identity"} {
		t.Run(failure, func(t *testing.T) {
			t.Parallel()
			env, streams := testEnv(t)
			hooks := []codexTrustHook{feltHook("session_start", "modified")}
			switch failure {
			case "missing":
				hooks = nil
			case "identity":
				hooks[0].Key = "other:0:0"
			}
			f := fakeCodexTrust(t, env, hooks)
			f.fail(failure)
			a := testApp(t, env)
			a.refreshCodexHookTrust()
			if !strings.Contains(streams.Stderr.String(), "Warning:") || !strings.Contains(streams.Stderr.String(), "felt setup codex --trust-hooks") {
				t.Fatalf("missing warning: %s", streams.Stderr.String())
			}
			receipt := a.collectHookReceipt([]ReceiptBundle{{Harness: "codex", Path: filepath.Join(repoRoot(t), "claude-plugin"), Status: receiptHealthy}})
			if receipt.Status == receiptHealthy || !strings.Contains(receipt.Repair, "felt setup codex --trust-hooks") || receipt.CodexTrust.State != codexTrustFailed {
				t.Fatalf("failure reported healthy: %#v", receipt)
			}
		})
	}
}

// A Codex without the trust API is advisory: setup warns, the receipt stays
// healthy and says to upgrade, and nothing is written.
func TestCodexHookTrustUnsupportedCodexIsAdvisory(t *testing.T) {
	for _, shape := range []string{"old-version", "old-method", "no-data", "no-plugin-id", "hash", "old-write"} {
		t.Run(shape, func(t *testing.T) {
			t.Parallel()
			env, streams := testEnv(t)
			hooks := []codexTrustHook{feltHook("session_start", "modified")}
			if shape == "hash" {
				hooks[0].CurrentHash = "sha256:old"
			}
			f := fakeCodexTrust(t, env, hooks)
			if shape == "old-version" {
				env.Set("TRUST_CODEX_VERSION", "0.147.0")
			} else {
				f.fail(shape)
			}
			a := testApp(t, env)
			a.refreshCodexHookTrust()
			if !strings.Contains(streams.Stderr.String(), "Warning:") || !strings.Contains(streams.Stderr.String(), "upgrade Codex to ≥ "+codexHookTrustMinimum) {
				t.Fatalf("missing upgrade warning: %s", streams.Stderr.String())
			}
			receipt := a.collectHookReceipt([]ReceiptBundle{{Harness: "codex", Path: filepath.Join(repoRoot(t), "claude-plugin"), Status: receiptHealthy}})
			// A read-only receipt never calls batchWrite, so only the version
			// gate classifies a Codex that lacks just the writer.
			if shape != "old-write" && (receipt.Status != receiptHealthy || receipt.CodexTrust == nil || receipt.CodexTrust.State != codexTrustUnsupported || !strings.Contains(receipt.CodexTrust.Note, codexHookTrustMinimum)) {
				t.Fatalf("unsupported Codex not advisory: %#v", receipt)
			}
			if shape != "old-write" && countMethod(f.requests(t), "config/batchWrite") != 0 {
				t.Fatal("unsupported Codex was written to")
			}
			if _, _, err := executeIn(t, env, t.TempDir(), "setup", "codex", "--trust-hooks"); err == nil || !strings.Contains(err.Error(), "upgrade Codex") {
				t.Fatalf("--trust-hooks on unsupported Codex: %v", err)
			}
		})
	}
}

// Trust is only recorded for the bytes of the promoted generation. Every
// other case writes nothing, and the repair is a reinstall.
func TestCodexHookTrustRefusesUnverifiedBytes(t *testing.T) {
	for _, tamper := range []string{"source-outside-cache", "cache-tampered", "unsealed-promotion", "cache-missing"} {
		t.Run(tamper, func(t *testing.T) {
			t.Parallel()
			env, streams := testEnv(t)
			hook := feltHook("session_start", "modified")
			if tamper == "source-outside-cache" {
				outside := filepath.Join(t.TempDir(), "hooks", "hooks.json")
				os.MkdirAll(filepath.Dir(outside), 0o755)
				os.WriteFile(outside, []byte("{}"), 0o644)
				hook.SourcePath = outside
			}
			f := fakeCodexTrust(t, env, []codexTrustHook{hook})
			promoted := filepath.Join(homeOf(t, env), ".felt", pluginRuntimeDirName, pluginCurrentName, "claude-plugin")
			switch tamper {
			case "cache-tampered":
				os.WriteFile(filepath.Join(f.cache, "hooks", "hooks.json"), []byte(`{"hooks":{"SessionStart":[]}}`), 0o644)
			case "unsealed-promotion":
				os.Remove(filepath.Join(promoted, pluginGenerationMarkerName))
			case "cache-missing":
				os.RemoveAll(f.cache)
			}
			a := testApp(t, env)
			if r := a.codexHookTrust(true); r.State != codexTrustUnverified {
				t.Fatalf("state = %s (%v), want unverified", r.State, r.Err)
			}
			a.refreshCodexHookTrust()
			if !strings.Contains(streams.Stderr.String(), "run `felt setup codex` to reinstall") {
				t.Fatalf("missing reinstall warning: %s", streams.Stderr.String())
			}
			_, _, err := executeIn(t, env, t.TempDir(), "setup", "codex", "--trust-hooks")
			if err == nil || !strings.Contains(err.Error(), "felt setup codex` to reinstall") {
				t.Fatalf("--trust-hooks laundered unverified bytes: %v", err)
			}
			if n := countMethod(f.requests(t), "config/batchWrite"); n != 0 {
				t.Fatalf("unverified bytes received %d trust writes", n)
			}
			receipt := a.collectHookReceipt([]ReceiptBundle{{Harness: "codex", Path: promoted, Status: receiptHealthy}})
			if receipt.Status == receiptHealthy || strings.Contains(receipt.Repair, "--trust-hooks") || !strings.Contains(receipt.Repair, "felt setup codex") {
				t.Fatalf("receipt repair for unverified bytes: %#v", receipt)
			}
		})
	}
}

func TestCodexHookReceiptIsReadOnlyAndChecksEveryHook(t *testing.T) {
	t.Parallel()
	env, _ := testEnv(t)
	hooks := []codexTrustHook{feltHook("session_start", "trusted"), feltHook("pre_tool_use", "trusted"), feltHook("stop", "modified")}
	hooks[1].CurrentHash = "sha256:" + strings.Repeat("c", 64) + "/sha256:" + strings.Repeat("b", 64)
	hooks[2].CurrentHash = "sha256:" + strings.Repeat("d", 64) + "/sha256:" + strings.Repeat("b", 64)
	f := fakeCodexTrust(t, env, hooks)
	a := testApp(t, env)
	if r := a.codexHookTrust(false); r.State != codexTrustFailed || !strings.Contains(r.Err.Error(), ":stop:") {
		t.Fatalf("modified stop hook not detected: %+v", r)
	}
	if countMethod(f.requests(t), "config/batchWrite") != 0 {
		t.Fatal("receipt wrote trust")
	}
}

func TestCodexHookTrustAbsentCodex(t *testing.T) {
	t.Parallel()
	env, streams := testEnv(t)
	sysenvtest.OnlyPath(env)
	a := testApp(t, env)
	a.refreshCodexHookTrust()
	if r := a.codexHookTrust(false); r.State != codexTrustAbsent {
		t.Fatal(r)
	}
	if streams.Stderr.String() != "" || streams.Stdout.String() != "" {
		t.Fatal("absent Codex was not quiet")
	}
	if _, _, err := executeIn(t, env, t.TempDir(), "setup", "codex", "--trust-hooks"); err == nil || !strings.Contains(err.Error(), "codex CLI") {
		t.Fatalf("--trust-hooks without codex: %v", err)
	}
}

// With a live server answering, the write goes through it, and both views
// are verified.
func TestCodexHookTrustWritesThroughLiveServer(t *testing.T) {
	t.Parallel()
	env, _ := testEnv(t)
	f := fakeCodexTrust(t, env, []codexTrustHook{feltHook("session_start", "modified"), feltHook("stop", "trusted")})
	socket, live := f.fakeLiveCodex(t, liveAnswers, nil)
	env.Set("SHUTTLE_CODEX_SOCKET", socket)
	a := testApp(t, env)
	r := a.codexHookTrust(true)
	if r.State != codexTrustTrusted || r.Live != codexLiveVerified || r.Endpoint != socket || r.EndpointSource != "SHUTTLE_CODEX_SOCKET" {
		t.Fatalf("live trust = %+v", r)
	}
	if countMethod(readTrustLog(t, live.log), "config/batchWrite") != 1 || countMethod(f.requests(t), "config/batchWrite") != 0 {
		t.Fatal("trust was not written through the live server")
	}
	receipt := a.collectHookReceipt([]ReceiptBundle{{Harness: "codex", Path: filepath.Join(repoRoot(t), "claude-plugin"), Status: receiptHealthy}})
	if receipt.Status != receiptHealthy || receipt.CodexTrust.Endpoint != socket || !strings.Contains(receipt.CodexTrust.Note, "verified") {
		t.Fatalf("receipt = %#v", receipt.CodexTrust)
	}
}

// A refused or silent live server must not break setup or deploy: the
// private server writes and verifies, and the live server is reported
// uninspected.
func TestCodexHookTrustUnreachableLiveServerIsAdvisory(t *testing.T) {
	for _, mode := range []liveMode{liveStale, liveHangs} {
		t.Run(string(mode), func(t *testing.T) {
			t.Parallel()
			env, streams := testEnv(t)
			f := fakeCodexTrust(t, env, []codexTrustHook{feltHook("session_start", "modified")})
			socket, live := f.fakeLiveCodex(t, mode, nil)
			env.Set("SHUTTLE_CODEX_SOCKET", socket)
			a := testApp(t, env)
			a.trustTimeout = 500 * time.Millisecond
			started := time.Now()
			a.refreshCodexHookTrust()
			if elapsed := time.Since(started); elapsed > 10*time.Second {
				t.Fatalf("unreachable live server held setup for %s", elapsed)
			}
			if !strings.Contains(streams.Stderr.String(), "was not inspected") || strings.Contains(streams.Stderr.String(), "Warning") {
				t.Fatalf("setup output: %s", streams.Stderr.String())
			}
			if countMethod(f.requests(t), "config/batchWrite") != 1 || countMethod(readTrustLog(t, live.log), "config/batchWrite") != 0 {
				t.Fatal("trust was not written through the private server")
			}
			receipt := a.collectHookReceipt([]ReceiptBundle{{Harness: "codex", Path: filepath.Join(repoRoot(t), "claude-plugin"), Status: receiptHealthy}})
			if receipt.Status != receiptHealthy || receipt.CodexTrust.Live != codexLiveUninspected || !strings.Contains(receipt.CodexTrust.Note, socket) {
				t.Fatalf("receipt = %#v %#v", receipt, receipt.CodexTrust)
			}
			if _, _, err := executeIn(t, env, t.TempDir(), "setup", "codex", "--trust-hooks"); err != nil {
				t.Fatalf("--trust-hooks with an unreachable live server: %v", err)
			}
		})
	}
}

func TestCodexHookTrustRejectsDivergentLiveServer(t *testing.T) {
	t.Parallel()
	env, _ := testEnv(t)
	f := fakeCodexTrust(t, env, []codexTrustHook{feltHook("session_start", "modified")})
	socket, _ := f.fakeLiveCodex(t, liveAnswers, []codexTrustHook{feltHook("session_start", "modified"), feltHook("stop", "modified")})
	env.Set("SHUTTLE_CODEX_SOCKET", socket)
	a := testApp(t, env)
	r := a.codexHookTrust(true)
	if r.State != codexTrustFailed || !strings.Contains(r.Err.Error(), "different felt hook set") {
		t.Fatalf("divergent live hooks = %+v", r)
	}
	receipt := a.collectHookReceipt([]ReceiptBundle{{Harness: "codex", Path: filepath.Join(repoRoot(t), "claude-plugin"), Status: receiptHealthy}})
	if receipt.Status == receiptHealthy {
		t.Fatal("receipt accepted a live server with a different hook set")
	}
}

// Deploy over ssh lacks SHUTTLE_CODEX_SOCKET; the running daemon names the
// endpoint instead.
func TestCodexHookTrustDiscoversEndpointFromDaemon(t *testing.T) {
	t.Parallel()
	env, _ := testEnv(t)
	f := fakeCodexTrust(t, env, []codexTrustHook{feltHook("session_start", "modified")})
	socket, live := f.fakeLiveCodex(t, liveAnswers, nil)
	env.Unset("SHUTTLE_CODEX_SOCKET")
	env.Set("FAKE_DAEMON_ENDPOINT", socket)
	sysenvtest.FakeCommand(t, env, "shuttle", `[ "$1 $2" = "version --json" ] || exit 2
printf '{"ready":true,"codex_backend":{"state":"ready","endpoint":"%s"}}\n' "$FAKE_DAEMON_ENDPOINT"
`)
	a := testApp(t, env)
	r := a.codexHookTrust(true)
	if r.State != codexTrustTrusted || r.Live != codexLiveVerified || r.Endpoint != socket || r.EndpointSource != "shuttle daemon" {
		t.Fatalf("daemon endpoint = %+v", r)
	}
	if countMethod(readTrustLog(t, live.log), "config/batchWrite") != 1 {
		t.Fatal("trust did not go through the daemon's live server")
	}
}

func TestCodexEndpointFallsBackWithoutDaemon(t *testing.T) {
	t.Parallel()
	env, _ := testEnv(t)
	env.Unset("SHUTTLE_CODEX_SOCKET")
	sysenvtest.FakeCommand(t, env, "shuttle", "exit 1\n")
	a := testApp(t, env)
	socket, source, err := a.codexEndpoint()
	if err != nil || source != "default" || !strings.HasPrefix(socket, "/tmp/shuttle-codex-") {
		t.Fatalf("endpoint = %q %q %v", socket, source, err)
	}
}
