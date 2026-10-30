package feltcli

// Codex owns hook hashes and trust persistence. Felt only approves hooks whose
// pluginId identifies its own plugin, using the hashes returned by hooks/list.

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/codexendpoint"
	"github.com/gorilla/websocket"
)

type codexTrustHook struct {
	Key         string `json:"key"`
	PluginID    string `json:"pluginId"`
	Source      string `json:"source"`
	SourcePath  string `json:"sourcePath"`
	CurrentHash string `json:"currentHash"`
	TrustStatus string `json:"trustStatus"`
}

type codexTrustRPC struct {
	cmd     *exec.Cmd
	input   io.WriteCloser
	decoder *json.Decoder
	seq     int
	cancel  context.CancelFunc
	ws      *websocket.Conn
}

func (a *app) openCodexTrustRPC() (*codexTrustRPC, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	cmd := a.env.CommandContext(ctx, "codex", "app-server")
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
	r := &codexTrustRPC{cmd: cmd, input: input, decoder: json.NewDecoder(output), cancel: cancel}
	if err := r.initialize(); err != nil {
		r.close()
		return nil, err
	}
	return r, nil
}

func openLiveCodexTrustRPC(socket string) (*codexTrustRPC, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	dialer := websocket.Dialer{NetDialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}
	conn, _, err := dialer.DialContext(ctx, "ws://localhost/", nil)
	if err != nil {
		return nil, err
	}
	conn.SetReadLimit(8 << 20)
	deadline, _ := ctx.Deadline()
	conn.SetReadDeadline(deadline)
	conn.SetWriteDeadline(deadline)
	r := &codexTrustRPC{ws: conn}
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

func (r *codexTrustRPC) call(method string, params, result any) error {
	r.seq++
	if err := r.send(map[string]any{"id": r.seq, "method": method, "params": params}); err != nil {
		return fmt.Errorf("codex %s: %w", method, err)
	}
	for frames := 0; frames < 256; frames++ {
		var response struct {
			ID     int             `json:"id"`
			Method string          `json:"method"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		var err error
		if r.ws != nil {
			err = r.ws.ReadJSON(&response)
		} else {
			err = r.decoder.Decode(&response)
		}
		if err != nil {
			return fmt.Errorf("codex %s: %w", method, err)
		}
		if response.Method != "" || response.ID != r.seq {
			continue
		}
		if len(response.Error) > 0 {
			return fmt.Errorf("codex %s: %s", method, response.Error)
		}
		if len(response.Result) == 0 || string(response.Result) == "null" {
			return fmt.Errorf("codex %s: missing result", method)
		}
		if err := json.Unmarshal(response.Result, result); err != nil {
			return fmt.Errorf("codex %s: %w", method, err)
		}
		return nil
	}
	return fmt.Errorf("codex %s: too many unrelated responses", method)
}

func (a *app) listFeltCodexHooks(r *codexTrustRPC) ([]codexTrustHook, error) {
	cwd, err := a.env.Getwd()
	if err != nil {
		return nil, err
	}
	var result struct {
		Data []struct {
			Hooks  []codexTrustHook `json:"hooks"`
			Errors []struct {
				Message string `json:"message"`
			} `json:"errors"`
		} `json:"data"`
	}
	if err := r.call("hooks/list", map[string]any{"cwds": []string{cwd}}, &result); err != nil {
		return nil, err
	}
	var hooks []codexTrustHook
	for _, entry := range result.Data {
		// Incomplete discovery must not be mistaken for a fully trusted install.
		if len(entry.Errors) > 0 {
			return nil, fmt.Errorf("codex hooks/list: %s", entry.Errors[0].Message)
		}
		for _, h := range entry.Hooks {
			if h.PluginID != codexPluginRef {
				continue
			}
			if h.Source != "plugin" || !strings.HasPrefix(h.Key, codexPluginRef+":") {
				return nil, fmt.Errorf("codex hooks/list: inconsistent felt hook identity %q", h.Key)
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
			return "", "", fmt.Errorf("unsupported Codex plugin hook hash %q", hash)
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

// An absent socket means there is no viewer runtime to check. An existing
// but unreachable server is an inspection failure, never replaced.
func (a *app) liveCodexTrustRPC() (*codexTrustRPC, error) {
	hostname, err := a.env.Hostname()
	if err != nil {
		return nil, err
	}
	socket, err := codexendpoint.Resolve(a.env.Getenv("SHUTTLE_CODEX_SOCKET"), a.env.EUID(), hostname)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(socket)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSocket == 0 {
		return nil, fmt.Errorf("Codex endpoint %s is not a socket", socket)
	}
	r, err := openLiveCodexTrustRPC(socket)
	if err != nil {
		return nil, fmt.Errorf("live Codex trust inspection: %w", err)
	}
	return r, nil
}

// codexHookTrust lists before any write and verifies afterwards. It also
// serves the read-only receipt path, which must detect stale persisted hashes.
func (a *app) codexHookTrust(write bool) error {
	if _, err := a.env.LookPath("codex"); err != nil {
		return nil
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
	live, err := a.liveCodexTrustRPC()
	if err != nil {
		return err
	}
	var liveHooks []codexTrustHook
	if live != nil {
		defer live.close()
		liveHooks, err = a.listFeltCodexHooks(live)
		if err != nil {
			return fmt.Errorf("live Codex trust inspection: %w", err)
		}
	}
	if write {
		edits := []map[string]any{}
		refreshLive := live != nil && compareCodexTrust(hooks, liveHooks) != nil
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
			var result struct {
				Status string `json:"status"`
			}
			writer := r
			if live != nil {
				writer = live
			}
			// A live server can have a different CODEX_HOME. Name this
			// invocation's config explicitly, never its implicit default.
			home := a.env.Getenv("CODEX_HOME")
			if home == "" {
				home, err = a.homePath(".codex")
				if err != nil {
					return err
				}
			}
			configPath, err := a.env.Abs(filepath.Join(home, "config.toml"))
			if err != nil {
				return err
			}
			if err := writer.call("config/batchWrite", map[string]any{"edits": edits, "reloadUserConfig": true, "filePath": configPath}, &result); err != nil {
				return err
			}
			if result.Status != "ok" {
				return fmt.Errorf("codex config/batchWrite: status %q", result.Status)
			}
			hooks, err = a.listFeltCodexHooks(r)
			if err != nil {
				return err
			}
		}
	}
	if err := requireFeltCodexTrust(hooks); err != nil {
		return err
	}
	if live != nil {
		liveHooks, err = a.listFeltCodexHooks(live)
		if err != nil {
			return err
		}
		if err := compareCodexTrust(hooks, liveHooks); err != nil {
			return err
		}
	}
	return nil
}

func compareCodexTrust(current, live []codexTrustHook) error {
	if err := requireFeltCodexTrust(live); err != nil {
		return fmt.Errorf("live Codex: %w", err)
	}
	if len(current) != len(live) {
		return fmt.Errorf("live Codex reports a different felt hook set")
	}
	byKey := make(map[string]string, len(current))
	for _, h := range current {
		byKey[h.Key] = h.CurrentHash
	}
	for _, h := range live {
		if byKey[h.Key] != h.CurrentHash {
			return fmt.Errorf("live Codex has a different definition or payload for felt hook %s", h.Key)
		}
	}
	return nil
}

func (a *app) refreshCodexHookTrust() {
	if err := a.codexHookTrust(true); err != nil {
		fmt.Fprintf(a.env.Stderr, "Warning: felt's Codex hooks could not be trusted: %v; run `felt setup codex --trust-hooks` to repair, then `felt setup receipt`.\n", err)
	}
}
