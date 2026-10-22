package messaging

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// This uses the real Codex protocol and TUI, but all inference goes to a local
// Responses fixture. It needs codex 0.162.1+ and tmux, not an account or tokens.
func TestCodexRealTerminalAppServer(t *testing.T) {
	codex, err := exec.LookPath("codex")
	if err != nil {
		t.Skip("codex is not installed")
	}
	tmux, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux is not installed")
	}
	if testing.Short() {
		t.Skip("real Codex terminal integration")
	}
	root, err := os.MkdirTemp("/tmp", "felt-cx-real-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	var calls atomic.Int32
	var sawContext atomic.Bool
	model := wsTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/responses" {
			http.Error(w, "fixture only serves Responses", http.StatusNotFound)
			return
		}
		n := calls.Add(1)
		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("model request: %v", err)
			return
		}
		encoded, _ := json.Marshal(request)
		if strings.Contains(string(encoded), "REMOTE_CONTEXT_ONLY") {
			sawContext.Store(true)
		}
		if request["model"] != "probe-model" {
			t.Errorf("unexpected model: %v", request["model"])
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		event := func(value any) {
			data, _ := json.Marshal(value)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", value.(map[string]any)["type"], data)
			w.(http.Flusher).Flush()
		}
		event(map[string]any{"type": "response.created", "response": map[string]any{"id": fmt.Sprintf("response-%d", n)}})
		if n == 1 {
			close(started)
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
		}
		event(map[string]any{"type": "response.output_item.done", "output_index": 0, "item": map[string]any{
			"type": "message", "id": fmt.Sprintf("message-%d", n), "role": "assistant",
			"content": []any{map[string]any{"type": "output_text", "text": "REMOTE_FIXTURE_REPLY"}},
		}})
		event(map[string]any{"type": "response.completed", "response": map[string]any{
			"id": fmt.Sprintf("response-%d", n), "status": "completed", "output": []any{},
			"usage": map[string]any{"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
		}})
	}))
	config := fmt.Sprintf(`model="probe-model"
model_provider="probe"
check_for_update_on_startup=false
approval_policy="never"
sandbox_mode="read-only"
[model_providers.probe]
name="probe"
base_url=%q
wire_api="responses"
requires_openai_auth=false
[projects.%q]
trust_level="trusted"
`, model.URL, root)
	if err := os.WriteFile(filepath.Join(root, "config.toml"), []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	var processEnv []string
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if !strings.HasPrefix(key, "CODEX_") && !strings.HasPrefix(key, "OPENAI_") && !strings.HasPrefix(key, "SHUTTLE_") && key != "TMUX" && key != "TERM" {
			processEnv = append(processEnv, entry)
		}
	}
	processEnv = append(processEnv, "CODEX_HOME="+root, "TERM=xterm-256color")
	logPath := filepath.Join(root, "server.log")
	log, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { log.Close() })
	socket := filepath.Join(root, "control.sock")
	server := exec.Command(codex, "app-server", "--listen", "unix://"+socket)
	server.Env, server.Dir, server.Stdout, server.Stderr = processEnv, root, log, log
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { server.Process.Kill(); server.Wait() })
	env := testEnv(t)
	env.Set("SHUTTLE_CODEX_SOCKET", socket)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	diagnostic := func() string { return "" }
	await := func(description string, condition func() bool) {
		t.Helper()
		for !condition() {
			select {
			case <-ctx.Done():
				logs, _ := os.ReadFile(logPath)
				t.Fatalf("timed out waiting for %s\n%s\npane:\n%s\nfixture calls: %d", description, logs, diagnostic(), calls.Load())
			case <-time.After(50 * time.Millisecond):
			}
		}
	}
	await("App Server readiness", func() bool {
		rpc, err := dialCodex(ctx, env)
		if err != nil {
			return false
		}
		rpc.c.Close()
		return true
	})
	tmuxSocket := filepath.Join(root, "tmux.sock")
	runTmux := func(args ...string) (string, error) {
		cmd := exec.CommandContext(ctx, tmux, append([]string{"-S", tmuxSocket}, args...)...)
		cmd.Env, cmd.Dir = processEnv, root
		out, err := cmd.CombinedOutput()
		return string(out), err
	}
	t.Cleanup(func() { exec.Command(tmux, "-S", tmuxSocket, "kill-server").Run() })
	if out, err := runTmux("new-session", "-d", "-s", "viewer", "-x", "180", "-y", "55", codex, "--remote", "unix://"+socket, "--no-alt-screen", "-C", root); err != nil {
		t.Fatalf("start TUI: %v\n%s", err, out)
	}
	lastPane := ""
	pane := func() string {
		out, err := runTmux("capture-pane", "-p", "-S", "-500", "-t", "viewer")
		if err == nil {
			lastPane = out
		}
		return lastPane
	}
	diagnostic = func() string { return lastPane }
	var session Session
	await("TUI thread", func() bool {
		ss, err := (codexAdapter{}).discover(ctx, env, "probe")
		if err == nil && len(ss) == 1 && strings.Contains(pane(), "probe-model") {
			session = ss[0]
			return session.State == "idle"
		}
		return false
	})
	if session.TranscriptID == "" {
		t.Fatal("native discovery omitted transcript identity")
	}
	send := func(id, text string, wake bool) Receipt {
		t.Helper()
		receipt, err := Send(ctx, env, "probe", Request{Address: session.Address, MessageID: id, Text: text, Wake: wake})
		if err != nil {
			t.Fatalf("send %s: %#v %v\npane:\n%s", id, receipt, err, pane())
		}
		return receipt
	}
	if receipt := send("external-start", "REMOTE_EXTERNAL_START", true); receipt.Status != StatusAccepted || receipt.Detail != "started turn" {
		t.Fatalf("idle delivery: %#v", receipt)
	}
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("model fixture did not receive first request")
	}
	if receipt := send("external-steer", "REMOTE_EXTERNAL_STEER", true); receipt.Status != StatusAccepted || receipt.Detail != "steered active turn" {
		t.Fatalf("active delivery: %#v", receipt)
	}
	unblock()
	await("live TUI messages and replies", func() bool {
		text := pane()
		return strings.Contains(text, "REMOTE_EXTERNAL_START") && strings.Contains(text, "REMOTE_EXTERNAL_STEER") && strings.Contains(text, "REMOTE_FIXTURE_REPLY")
	})
	await("idle thread", func() bool {
		ss, _ := (codexAdapter{}).discover(ctx, env, "probe")
		for _, candidate := range ss {
			if candidate.ID == session.ID {
				return candidate.State == "idle"
			}
		}
		return false
	})
	// Native acknowledgements deduplicate retries; the terminal receives no paste.
	// Codex can also make local fixture calls for automatic thread titles.
	time.Sleep(200 * time.Millisecond)
	completedCalls := calls.Load()
	send("external-start", "REMOTE_EXTERNAL_START", true)
	if calls.Load() != completedCalls {
		t.Fatalf("same-id retry started inference: %d -> %d", completedCalls, calls.Load())
	}
	if receipt := send("external-context", "REMOTE_CONTEXT_ONLY", false); receipt.Status != StatusContextAdded {
		t.Fatalf("context delivery: %#v", receipt)
	}
	// inject_items adds model context, not a separate visible TUI turn.
	send("context-followup", "REMOTE_AFTER_CONTEXT", true)
	await("injected context in the next model request", sawContext.Load)
	await("followup TUI reply", func() bool {
		return strings.Contains(pane(), "REMOTE_AFTER_CONTEXT") && strings.Count(pane(), "REMOTE_FIXTURE_REPLY") >= 2
	})
	time.Sleep(200 * time.Millisecond)
	completedCalls = calls.Load()
	// Losing the viewer does not lose the backend conversation. Reattach the
	// exact thread without a prompt, so no additional model turn is started.
	if out, err := runTmux("kill-session", "-t", "viewer"); err != nil {
		t.Fatalf("close viewer: %v %s", err, out)
	}
	if out, err := runTmux("new-session", "-d", "-s", "viewer", "-x", "180", "-y", "55", codex, "--remote", "unix://"+socket, "--no-alt-screen", "resume", session.ID); err != nil {
		t.Fatalf("resume viewer: %v %s", err, out)
	}
	await("resumed TUI history", func() bool {
		return strings.Contains(pane(), "REMOTE_EXTERNAL_START") && strings.Contains(pane(), "REMOTE_FIXTURE_REPLY")
	})
	if calls.Load() != completedCalls {
		t.Fatalf("view-only resume started inference: %d -> %d requests", completedCalls, calls.Load())
	}
	t.Logf("real Codex App Server + terminal TUI: idle start, active steer, context, dedup, same-thread resume; %d local fixture calls, no external inference", calls.Load())
}
