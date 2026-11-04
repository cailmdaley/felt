package feltcli

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// This is a compatibility probe, not permission to bypass Codex's runtime
// checks. No account, operator files, shared daemon or model service is used.
func TestCodexHookTrustRealLiveRefresh(t *testing.T) {
	t.Parallel()
	env, _ := testEnv(t)
	if _, err := env.LookPath("codex"); err != nil {
		t.Skip("codex is not installed")
	}
	root, err := os.MkdirTemp("/tmp", "felt-live-hooktrust-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	env.Set("HOME", root)
	env.Set("CODEX_HOME", filepath.Join(root, ".codex"))
	env.Chdir(root)
	a := testApp(t, env)
	if version, old := a.codexVersionTooOld(); old {
		t.Skipf("Codex %s predates plugin content trust", version)
	}
	// Failed hooks must not accidentally send a prompt to a public provider.
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"private-probe\",\"status\":\"completed\",\"output\":[],\"usage\":{\"input_tokens\":0,\"output_tokens\":0,\"total_tokens\":0}}}\n\n")
	}))
	defer endpoint.Close()
	if err := os.MkdirAll(filepath.Join(root, ".codex"), 0700); err != nil {
		t.Fatal(err)
	}
	config := fmt.Sprintf("model = 'private-probe'\nmodel_provider = 'private-probe'\n[model_providers.private-probe]\nname = 'private-probe'\nbase_url = %q\nwire_api = 'responses'\n[features]\nhooks = true\nplugins = true\n", endpoint.URL)
	if err := os.WriteFile(filepath.Join(root, ".codex", "config.toml"), []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "source")
	for _, name := range []string{".claude-plugin", "claude-plugin"} {
		if err := copyTree(filepath.Join(repoRoot(t), name), filepath.Join(source, name)); err != nil {
			t.Fatal(err)
		}
	}
	manifest := filepath.Join(source, "claude-plugin", "hooks", "hooks.json")
	writeManifest := func(generation string) {
		t.Helper()
		// The comment identifies a validated felt hook basename. The command
		// itself only writes inside this test's private home.
		command := fmt.Sprintf("echo %s >> %q # /hooks/session.sh", generation, filepath.Join(root, "fired"))
		hooks := map[string]any{"hooks": map[string]any{}}
		for _, event := range []string{"SessionStart", "UserPromptSubmit"} {
			hooks["hooks"].(map[string]any)[event] = []any{map[string]any{"hooks": []any{map[string]any{"type": "command", "command": command}}}}
		}
		data, _ := json.Marshal(hooks)
		if err := os.WriteFile(manifest, data, 0644); err != nil {
			t.Fatal(err)
		}
	}
	setup := func() {
		t.Helper()
		if err := a.installCodexPluginViaCLI(source); err != nil {
			t.Fatal(err)
		}
		if r := a.codexHookTrust(false); r.State != codexTrustTrusted {
			t.Fatalf("persisted trust: %+v", r)
		}
	}
	open := func() *codexTrustRPC {
		t.Helper()
		rpc, err := a.openCodexTrustRPC()
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(rpc.close)
		return rpc
	}
	thread := func(rpc *codexTrustRPC) string {
		t.Helper()
		var response struct {
			Thread struct {
				ID string `json:"id"`
			} `json:"thread"`
		}
		if err := rpc.call("thread/start", map[string]any{"cwd": root, "ephemeral": false, "approvalPolicy": "never", "sandbox": "danger-full-access"}, &response); err != nil {
			t.Fatal(err)
		}
		return response.Thread.ID
	}
	writeManifest("A")
	setup()
	live := open()
	id := thread(live)
	first := privateCodexHookTurn(t, live, id)
	requirePrivateHookStatus(t, first, "completed", "")
	writeManifest("B")
	setup()
	// The receipt is trusted, but both existing and new threads on the old
	// server still hold the old definition and approval in memory.
	for _, id := range []string{id, thread(live)} {
		runs := privateCodexHookTurn(t, live, id)
		requirePrivateHookStatus(t, runs, "failed", "plugin contents changed; hook approval required")
	}
	fresh := open()
	// Approval through the affected server's config API refreshes its loaded
	// runtime. A private setup writer cannot perform this reload for it.
	hooks, err := a.listFeltCodexHooks(fresh)
	if err != nil {
		t.Fatal(err)
	}
	var edits []map[string]any
	for _, h := range hooks {
		definition, content, err := codexTrustHashes(h.CurrentHash)
		if err != nil {
			t.Fatal(err)
		}
		key, _ := json.Marshal(h.Key)
		edits = append(edits, map[string]any{"keyPath": "hooks.state." + string(key), "value": map[string]string{"trusted_hash": definition, "trusted_content_hash": content}, "mergeStrategy": "upsert"})
	}
	var written json.RawMessage
	if err := live.call("config/batchWrite", map[string]any{"edits": edits, "reloadUserConfig": true, "filePath": filepath.Join(root, ".codex", "config.toml")}, &written); err != nil {
		t.Fatal(err)
	}
	requirePrivateHookStatus(t, privateCodexHookTurn(t, live, id), "completed", "")
	// Release the original writer before resuming the saved conversation.
	live.close()
	var resumed json.RawMessage
	if err := fresh.call("thread/resume", map[string]any{"threadId": id}, &resumed); err != nil {
		t.Fatal(err)
	}
	requirePrivateHookStatus(t, privateCodexHookTurn(t, fresh, id), "completed", "")
	fired, err := os.ReadFile(filepath.Join(root, "fired"))
	if err != nil {
		t.Fatal(err)
	}
	if string(fired) != "A\nA\nB\nB\nB\n" {
		t.Fatalf("unexpected hook executions: %q", fired)
	}
}

type privateCodexHookRun struct {
	EventName string `json:"eventName"`
	Status    string `json:"status"`
	Entries   []struct {
		Text string `json:"text"`
	} `json:"entries"`
}

// Read responses and notifications together: a fast hook may finish before
// the turn/start response. Interrupt after the prompt hook; the only possible
// inference endpoint is the test's loopback server.
func privateCodexHookTurn(t *testing.T, rpc *codexTrustRPC, thread string) []privateCodexHookRun {
	t.Helper()
	rpc.seq++
	startID := rpc.seq
	if err := rpc.send(map[string]any{"id": startID, "method": "turn/start", "params": map[string]any{"threadId": thread, "input": []any{map[string]any{"type": "text", "text": "private hook probe"}}}}); err != nil {
		t.Fatal(err)
	}
	var runs []privateCodexHookRun
	var turn string
	interrupted := false
	deadline := time.Now().Add(rpc.timeout)
	for {
		data, err := rpc.read(deadline)
		if err != nil {
			t.Fatal(err)
		}
		var frame struct {
			ID     int             `json:"id"`
			Method string          `json:"method"`
			Error  json.RawMessage `json:"error"`
			Result struct {
				Turn struct {
					ID string `json:"id"`
				} `json:"turn"`
			} `json:"result"`
			Params struct {
				Run privateCodexHookRun `json:"run"`
			} `json:"params"`
		}
		if err := json.Unmarshal(data, &frame); err != nil {
			t.Fatal(err)
		}
		if len(frame.Error) > 0 {
			t.Fatalf("Codex RPC error: %s", data)
		}
		if frame.ID == startID {
			turn = frame.Result.Turn.ID
		}
		if frame.Method == "hook/completed" {
			runs = append(runs, frame.Params.Run)
		}
		if !interrupted && turn != "" && len(runs) > 0 && runs[len(runs)-1].EventName == "userPromptSubmit" {
			rpc.seq++
			if err := rpc.send(map[string]any{"id": rpc.seq, "method": "turn/interrupt", "params": map[string]any{"threadId": thread, "turnId": turn}}); err != nil {
				t.Fatal(err)
			}
			interrupted = true
		}
		if frame.Method == "turn/completed" {
			return runs
		}
	}
}

func requirePrivateHookStatus(t *testing.T, runs []privateCodexHookRun, status, message string) {
	t.Helper()
	if len(runs) == 0 {
		t.Fatal("Codex executed no hooks")
	}
	for _, run := range runs {
		data, _ := json.Marshal(run.Entries)
		if run.Status != status || (message != "" && !strings.Contains(string(data), message)) {
			t.Fatalf("hook %s: status %s entries %s; want %s %q", run.EventName, run.Status, data, status, message)
		}
	}
}
