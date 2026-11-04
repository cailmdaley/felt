package feltcli

import (
	"bytes"
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
	requireRealCodex(t, env)
	root, err := os.MkdirTemp("/tmp", "felt-live-hooktrust-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	env.Set("HOME", root)
	env.Set("CODEX_HOME", filepath.Join(root, ".codex"))
	env.Chdir(root)
	var output bytes.Buffer
	env.Stdout = &output
	a := testApp(t, env)
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
		assertPrivateCodexSkills(t, a, root)
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
	// Reproduce the deployed combined plugin, including in-root provenance,
	// before invoking the split installer. Approval belongs to the live server.
	writeManifest("A")
	current := filepath.Join(root, ".felt", pluginRuntimeDirName, pluginCurrentName)
	for _, name := range []string{".claude-plugin", "claude-plugin"} {
		if err := copyTree(filepath.Join(source, name), filepath.Join(current, name)); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(current, "claude-plugin", pluginGenerationMarkerName), []byte(`{"resolved_commit":"old-release"}`), 0644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"plugin", "marketplace", "add", current}, {"plugin", "add", codexPluginRef}} {
		if out, err := a.runCodexCLIQuiet(args...); err != nil {
			t.Fatalf("legacy Codex %v: %v %s", args, err, out)
		}
	}
	legacy := open()
	legacyHooks, err := a.listFeltCodexHooks(legacy)
	if err != nil {
		t.Fatal(err)
	}
	oldSkillPath := filepath.Join(filepath.Dir(filepath.Dir(legacyHooks[0].SourcePath)), "skills", "felt", "SKILL.md")
	if _, err := os.ReadFile(oldSkillPath); err != nil {
		t.Fatal(err)
	}
	var oldSkills json.RawMessage
	if err := legacy.call("skills/list", map[string]any{"cwds": []string{root}, "forceReload": false}, &oldSkills); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"felt:felt", "felt:shuttle"} {
		if !bytes.Contains(oldSkills, []byte(`"name":"`+name+`"`)) {
			t.Fatalf("combined skill not discovered: %s", name)
		}
	}
	approvePrivateCodexHooks(t, legacy, filepath.Join(root, ".codex"), legacyHooks)
	legacyID := thread(legacy)
	requirePrivateHookStatus(t, privateCodexHookTurn(t, legacy, legacyID), "completed", "")
	writeManifest("A")
	syncTestGit(t, source, "init")
	syncTestGit(t, source, "add", ".")
	syncTestGit(t, source, "-c", "user.name=Private probe", "-c", "user.email=probe@example.invalid", "commit", "-m", "plugin baseline")
	setup()
	if strings.Count(output.String(), "Codex hook bundle changed:") != 1 {
		t.Fatalf("migration warning: %s", output.String())
	}
	if _, err := os.ReadFile(oldSkillPath); !os.IsNotExist(err) {
		t.Fatalf("expected old combined skill path to vanish at migration: %s (%v)", oldSkillPath, err)
	}
	var migratedSkills json.RawMessage
	if err := legacy.call("skills/list", map[string]any{"cwds": []string{root}, "forceReload": false}, &migratedSkills); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"felt-skills:felt", "felt-skills:shuttle"} {
		if !bytes.Contains(migratedSkills, []byte(`"name":"`+name+`"`)) {
			t.Fatalf("live skill inventory did not follow migration: %s", name)
		}
	}
	if bytes.Contains(migratedSkills, []byte(`"name":"felt:felt"`)) {
		t.Fatal("live inventory retained the removed combined skill")
	}
	requirePrivateHookStatus(t, privateCodexHookTurn(t, legacy, legacyID), "failed", "plugin contents changed; hook approval required")
	live := open()
	id := thread(live)
	first := privateCodexHookTurn(t, live, id)
	requirePrivateHookStatus(t, first, "completed", "")
	// A real successive source revision changes only Go code. Setup advances
	// external provenance, leaves every installed file untouched, and the
	// same live thread executes its next hook without a runtime reload.
	cache, err := a.verifiedCodexCacheRoot()
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]os.FileInfo{}
	beforeDigests := map[string]string{}
	for _, name := range codexBundleNames {
		bundle, err := a.verifiedCodexBundleRoot(name)
		if err != nil {
			t.Fatal(err)
		}
		if err := filepath.Walk(bundle, func(path string, info os.FileInfo, err error) error {
			if err == nil {
				files[path] = info
			}
			return err
		}); err != nil {
			t.Fatal(err)
		}
		digest, err := pluginPayloadDigest(bundle)
		if err != nil {
			t.Fatal(err)
		}
		beforeDigests[bundle] = digest
	}
	writeSyncFile(t, source, "cmd/felt/main.go", "package main // Go-only revision\n")
	syncTestGit(t, source, "add", ".")
	syncTestGit(t, source, "-c", "user.name=Private probe", "-c", "user.email=probe@example.invalid", "commit", "-m", "Go-only revision")
	setup()
	for bundle, before := range beforeDigests {
		after, err := pluginPayloadDigest(bundle)
		if err != nil || before != after {
			t.Fatalf("Go-only release changed hashed bytes at %s: %s -> %s (%v)", bundle, before, after, err)
		}
	}
	identity, err := readPluginGeneration(filepath.Join(current, "claude-plugin"))
	if err != nil {
		t.Fatal(err)
	}
	if identity.ResolvedCommit != syncTestGit(t, source, "rev-parse", "HEAD") {
		t.Fatalf("external provenance did not advance: %+v", identity)
	}
	for path, before := range files {
		after, err := os.Stat(path)
		if err != nil || !after.ModTime().Equal(before.ModTime()) {
			t.Fatalf("unchanged plugin was reinstalled: %s (%v)", path, err)
		}
	}
	requirePrivateHookStatus(t, privateCodexHookTurn(t, live, id), "completed", "")
	// Refresh skills through the production installer without changing hook bytes
	// or approval, and keep using the exact same live thread.
	output.Reset()
	skill := filepath.Join(source, "claude-plugin", "skills", "felt", "SKILL.md")
	data, err := os.ReadFile(skill)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(skill, append(data, []byte("\nPrivate skills revision.\n")...), 0644); err != nil {
		t.Fatal(err)
	}
	setup()
	if strings.Contains(output.String(), "Codex hook bundle changed:") {
		t.Fatalf("skills update warned of hook cutover: %s", output.String())
	}
	for path, before := range files {
		if path != cache && !strings.HasPrefix(path, cache+string(filepath.Separator)) {
			continue
		}
		after, err := os.Stat(path)
		if err != nil || !after.ModTime().Equal(before.ModTime()) {
			t.Fatalf("skills refresh touched hook bundle: %s (%v)", path, err)
		}
	}
	if err := a.verifyCodexLoadedBundle(current, "felt-skills"); err != nil {
		t.Fatal(err)
	}
	requirePrivateHookStatus(t, privateCodexHookTurn(t, live, id), "completed", "")
	output.Reset()
	writeManifest("B")
	setup()
	if strings.Count(output.String(), "Codex hook bundle changed:") != 1 {
		t.Fatalf("hook update warning: %s", output.String())
	}
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
	approvePrivateCodexHooks(t, live, filepath.Join(root, ".codex"), hooks)
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
	if string(fired) != "A\nA\nA\nA\nA\nA\nB\nB\nB\n" {
		t.Fatalf("unexpected hook executions: %q", fired)
	}
}

func approvePrivateCodexHooks(t *testing.T, rpc *codexTrustRPC, home string, hooks []codexTrustHook) {
	t.Helper()
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
	if err := rpc.call("config/batchWrite", map[string]any{"edits": edits, "reloadUserConfig": true, "filePath": filepath.Join(home, "config.toml")}, &written); err != nil {
		t.Fatal(err)
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
