package messaging

import (
	"bufio"
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

// TestCodexEmbeddedHolderRefusesNativeWake proves a live embedded CLI remains
// the owner even when a separate App Server can load its shadow thread.
func TestCodexEmbeddedHolderRefusesNativeWake(t *testing.T) {
	codex, err := exec.LookPath("codex")
	if err != nil {
		t.Skip("codex is not installed")
	}
	if testing.Short() {
		t.Skip("real Codex holder integration")
	}
	root, err := os.MkdirTemp("/tmp", "felt-cx-holder-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	started, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	var calls atomic.Int32
	model := wsTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/responses" {
			http.Error(w, "fixture only", 404)
			return
		}
		var req map[string]any
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decode: %v", err)
			return
		}
		n := calls.Add(1)
		if n == 1 {
			close(started)
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, v := range []map[string]any{{"type": "response.created", "response": map[string]any{"id": "holder-response"}}, {"type": "response.output_item.done", "output_index": 0, "item": map[string]any{"type": "message", "id": "holder-message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "HOLDER_REPLY"}}}}, {"type": "response.completed", "response": map[string]any{"id": "holder-response", "status": "completed", "output": []any{}, "usage": map[string]any{"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}}} {
			b, _ := json.Marshal(v)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", v["type"], b)
			w.(http.Flusher).Flush()
		}
	}))
	config := fmt.Sprintf(`model="probe-model"
model_provider="probe"
check_for_update_on_startup=false
[model_providers.probe]
name="probe"
base_url=%q
wire_api="responses"
requires_openai_auth=false
`, model.URL)
	if err := os.WriteFile(filepath.Join(root, "config.toml"), []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	clean := []string{}
	for _, e := range os.Environ() {
		k, _, _ := strings.Cut(e, "=")
		if !strings.HasPrefix(k, "CODEX_") && !strings.HasPrefix(k, "OPENAI_") && !strings.HasPrefix(k, "SHUTTLE_") && k != "HOME" && k != "TERM" {
			clean = append(clean, e)
		}
	}
	clean = append(clean, "HOME="+root, "CODEX_HOME="+root, "TERM=xterm-256color")
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, codex, "exec", "--json", "--skip-git-repo-check", "-C", root, "--model", "probe-model", "--", "HOLDER_FIRST_TURN")
	cmd.Env = clean
	cmd.Stdin = strings.NewReader("")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		releaseOnce.Do(func() { close(release) })
		if cmd.ProcessState == nil {
			cmd.Process.Kill()
			cmd.Wait()
		}
	}()
	threadCh := make(chan string, 1)
	var cliOutput strings.Builder
	go func() {
		s := bufio.NewScanner(stdout)
		for s.Scan() {
			cliOutput.WriteString(s.Text() + "\\n")
			var e map[string]any
			if json.Unmarshal(s.Bytes(), &e) == nil && e["type"] == "thread.started" {
				if id, ok := e["thread_id"].(string); ok {
					select {
					case threadCh <- id:
					default:
					}
				}
			}
		}
	}()
	var id string
	select {
	case id = <-threadCh:
	case <-ctx.Done():
		t.Fatalf("no thread.started: %s", stderr.String())
	}
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("embedded first response did not reach local fixture")
	}
	// Start a separate App Server while the embedded process owns the thread.
	// Codex may itself refuse a competing writer; the wake path must still honor
	// the registered holder before attempting native thread control.
	shadowHome := filepath.Join(root, "shadow-home")
	if err := os.Mkdir(shadowHome, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(shadowHome, "config.toml"), []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(root, "shadow.sock")
	log, err := os.Create(filepath.Join(root, "shadow.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	server := exec.Command(codex, "app-server", "--listen", "unix://"+socket)
	server.Env = append(clean, "CODEX_HOME="+shadowHome)
	server.Dir = root
	server.Stdout = log
	server.Stderr = log
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { server.Process.Kill(); server.Wait() }()
	apiEnv := testEnv(t)
	apiEnv.Set("SHUTTLE_CODEX_SOCKET", socket)
	var rpc *rpcClient
	for rpc == nil {
		select {
		case <-ctx.Done():
			t.Fatal("shadow App Server did not start")
		case <-time.After(50 * time.Millisecond):
		}
		rpc, _ = dialCodex(ctx, apiEnv)
	}
	defer rpc.c.Close()
	if err := RegisterMailbox(apiEnv, "codex", id, "host", root, cmd.Process.Pid, true); err != nil {
		t.Fatalf("register actual embedded process PID %d: %v", cmd.Process.Pid, err)
	}
	wake := Request{Address: "shuttle://host/codex/" + id, MessageID: "live-holder-wake", Text: "must not wake shadow", Wake: true}
	receipt, sendErr := Send(ctx, apiEnv, "host", wake)
	if sendErr == nil || receipt.Status != StatusRejected || receipt.Transport != "codex-app-server" {
		t.Fatalf("live embedded holder wake was not refused: %#v %v", receipt, sendErr)
	}
	if calls.Load() != 1 {
		t.Fatalf("wake reached model fixture while embedded process alive: calls=%d", calls.Load())
	}
	// Context-only delivery must queue rather than mutate the loaded native shadow.
	contextReq := wake
	contextReq.Wake = false
	contextReq.MessageID = "live-holder-context"
	queued, queueErr := Send(ctx, apiEnv, "host", contextReq)
	if queueErr != nil || queued.Status != StatusQueued || queued.Transport != "codex-hook" {
		t.Fatalf("context did not queue for live holder: %#v %v", queued, queueErr)
	}
	if calls.Load() != 1 {
		t.Fatalf("context delivery reached model fixture: calls=%d", calls.Load())
	}
	releaseOnce.Do(func() { close(release) })
	if err := cmd.Wait(); err != nil {
		t.Fatalf("embedded process exit: %v\\n%s\\nstdout:\\n%s", err, stderr.String(), cliOutput.String())
	}
	if cmd.ProcessState == nil || !cmd.ProcessState.Exited() {
		t.Fatal("embedded holder did not exit before test ended")
	}
	t.Logf("live embedded PID %d retained ownership against separate App Server for thread %s; wake refused, context queued", cmd.Process.Pid, id)
}

// This proves developer instructions survive native rollout persistence and a
// cold App Server restart. All inference is served by the local Responses fixture.
func TestCodexEmbeddedColdResumePreservesDeveloperInstructions(t *testing.T) {
	codex, err := exec.LookPath("codex")
	if err != nil {
		t.Skip("codex is not installed")
	}
	if testing.Short() {
		t.Skip("real Codex cold-resume integration")
	}
	root, err := os.MkdirTemp("/tmp", "felt-cx-cold-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	const marker = "COLD_RESUME_OLD_DEVELOPER_INSTRUCTIONS"
	var calls atomic.Int32
	var sawMarker atomic.Bool
	var initialHasMarker atomic.Bool
	var negativeControlSeen atomic.Bool
	var negativeControlHasMarker atomic.Bool
	model := wsTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/responses" {
			http.Error(w, "fixture only", 404)
			return
		}
		var req map[string]any
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decode request: %v", err)
			return
		}
		if req["model"] != "probe-model" {
			t.Errorf("unexpected model %v", req["model"])
			return
		}
		encoded, _ := json.Marshal(req)
		found := false
		if input, ok := req["input"].([]any); ok {
			for _, raw := range input {
				if item, ok := raw.(map[string]any); ok && item["role"] == "developer" {
					b, _ := json.Marshal(item)
					if strings.Contains(string(b), marker) {
						found = true
					}
				}
			}
		}
		if strings.Contains(string(encoded), "Give a brief reply.") && found {
			initialHasMarker.Store(true)
		}
		if strings.Contains(string(encoded), "COLD_NEGATIVE_CONTROL") {
			negativeControlSeen.Store(true)
			if found {
				negativeControlHasMarker.Store(true)
			}
			if found {
				t.Errorf("negative-control initial request unexpectedly contained the developer marker")
			}
		}
		if strings.Contains(string(encoded), "COLD_RESUME_FOLLOWUP") {
			if found {
				sawMarker.Store(true)
			} else {
				t.Errorf("cold resumed model request omitted persisted developer instruction %q", marker)
			}
		}
		n := calls.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		event := func(v map[string]any) {
			b, _ := json.Marshal(v)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", v["type"], b)
			w.(http.Flusher).Flush()
		}
		event(map[string]any{"type": "response.created", "response": map[string]any{"id": fmt.Sprintf("cold-%d", n)}})
		event(map[string]any{"type": "response.output_item.done", "output_index": 0, "item": map[string]any{"type": "message", "id": fmt.Sprintf("msg-%d", n), "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "COLD_FIXTURE_REPLY"}}}})
		event(map[string]any{"type": "response.completed", "response": map[string]any{"id": fmt.Sprintf("cold-%d", n), "status": "completed", "output": []any{}, "usage": map[string]any{"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}})
	}))
	config := fmt.Sprintf(`model="probe-model"
model_provider="probe"
check_for_update_on_startup=false
[model_providers.probe]
name="probe"
base_url=%q
wire_api="responses"
requires_openai_auth=false
`, model.URL)
	if err := os.WriteFile(filepath.Join(root, "config.toml"), []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	env := make([]string, 0)
	for _, e := range os.Environ() {
		k, _, _ := strings.Cut(e, "=")
		if !strings.HasPrefix(k, "CODEX_") && !strings.HasPrefix(k, "OPENAI_") && !strings.HasPrefix(k, "SHUTTLE_") && k != "HOME" && k != "TERM" {
			env = append(env, e)
		}
	}
	env = append(env, "HOME="+root, "CODEX_HOME="+root, "TERM=xterm-256color")
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, codex, "exec", "--json", "--skip-git-repo-check", "-C", root, "--model", "probe-model", "-c", `developer_instructions="`+marker+`"`, "--", "Give a brief reply.")
	cmd.Env = append(env, "CODEX_HOME="+root)
	// Supply the marker as an invocation-only developer-role override. It is
	// intentionally absent from config.toml when the fresh App Server starts.
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("embedded codex exec: %v\n%s", err, out)
	}
	var threadID string
	for _, line := range strings.Split(string(out), "\n") {
		var event map[string]any
		if json.Unmarshal([]byte(line), &event) == nil && event["type"] == "thread.started" {
			threadID, _ = event["thread_id"].(string)
		}
	}
	if threadID == "" {
		t.Fatalf("exec output omitted thread.started identity:\n%s", out)
	}
	if calls.Load() != 1 {
		t.Fatalf("initial embedded turn made %d fixture requests, want exactly one", calls.Load())
	}
	assertInitialMarker := func(present bool) bool { return present }
	if !assertInitialMarker(initialHasMarker.Load()) {
		t.Fatal("initial embedded model request lacked the invocation-only developer instruction")
	}
	// Run a second actual embedded turn without -c. Its initial model request
	// must omit the marker, demonstrating that the baseline check is sensitive.
	negative := exec.CommandContext(ctx, codex, "exec", "--json", "--skip-git-repo-check", "-C", root, "--model", "probe-model", "--", "COLD_NEGATIVE_CONTROL")
	negative.Env = env
	if output, err := negative.CombinedOutput(); err != nil {
		t.Fatalf("negative-control embedded exec: %v\\n%s", err, output)
	}
	if !negativeControlSeen.Load() {
		t.Fatal("negative-control embedded request was not observed")
	}
	if assertInitialMarker(negativeControlHasMarker.Load()) {
		t.Fatal("negative control unexpectedly passed the initial developer-marker assertion")
	}

	// The embedded CLI must be fully gone before this new server opens the same
	// CODEX_HOME; otherwise an in-memory thread could conceal missing rollout data.
	socket := filepath.Join(root, "cold.sock")
	log, err := os.Create(filepath.Join(root, "cold-server.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	server := exec.Command(codex, "app-server", "--listen", "unix://"+socket)
	server.Env = env
	server.Dir = root
	server.Stdout = log
	server.Stderr = log
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { server.Process.Kill(); server.Wait() }()
	apiEnv := testEnv(t)
	apiEnv.Set("SHUTTLE_CODEX_SOCKET", socket)
	var rpc *rpcClient
	for rpc == nil {
		select {
		case <-ctx.Done():
			b, _ := os.ReadFile(filepath.Join(root, "cold-server.log"))
			t.Fatalf("new App Server not ready: %s", b)
		case <-time.After(100 * time.Millisecond):
		}
		rpc, _ = dialCodex(ctx, apiEnv)
	}
	defer rpc.c.Close()
	var resumed json.RawMessage
	if err := rpc.call(ctx, "thread/resume", map[string]any{"threadId": threadID}, &resumed); err != nil {
		t.Fatalf("resume persisted thread %s on cold server: %v", threadID, err)
	}
	var read struct {
		Thread codexThread `json:"thread"`
	}
	if err := rpc.call(ctx, "thread/read", map[string]any{"threadId": threadID, "includeTurns": true}, &read); err != nil {
		t.Fatalf("read persisted thread %s: %v", threadID, err)
	}
	if read.Thread.ID != threadID {
		t.Fatalf("cold server returned thread %q, want %q", read.Thread.ID, threadID)
	}
	if len(read.Thread.Turns) == 0 {
		t.Fatal("cold read found no persisted turns")
	}
	before := calls.Load()
	var started struct {
		Turn struct{ ID, Status string } `json:"turn"`
	}
	if err := rpc.call(ctx, "turn/start", map[string]any{"threadId": threadID, "input": userInput("COLD_RESUME_FOLLOWUP")}, &started); err != nil {
		t.Fatalf("start same-thread cold followup: %v", err)
	}
	if started.Turn.ID == "" {
		t.Fatalf("cold followup did not start a turn: %#v", started)
	}
	for calls.Load() == before {
		select {
		case <-ctx.Done():
			t.Fatal("cold followup never reached local model fixture")
		case <-time.After(25 * time.Millisecond):
		}
	}
	// Allow fixture decode/assertions to run before checking its call count.
	time.Sleep(100 * time.Millisecond)
	if calls.Load() != before+1 {
		t.Fatalf("cold followup made %d requests, want one", calls.Load()-before)
	}
	if !sawMarker.Load() {
		t.Fatal("cold resumed model request did not retain the original developer instruction")
	}
	t.Logf("cold native resume preserved thread %s across processes; local fixture calls=%d", threadID, calls.Load())
}
