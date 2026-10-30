package feltcli

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pelletier/go-toml/v2"
)

// No account, inference, operator config or installed plugin is used here.
// Negative controls: drop batchWrite or trusted_content_hash; the already
// running observer and the live Unix server must both refuse the new payload.
func TestCodexHookTrustRealAppServer(t *testing.T) {
	t.Parallel()
	env, _ := testEnv(t)
	if _, err := env.LookPath("codex"); err != nil {
		t.Skip("codex is not installed")
	}
	root, err := os.MkdirTemp("/tmp", "felt-hooktrust-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	env.Set("HOME", root)
	env.Set("CODEX_HOME", root)
	env.Set("SHUTTLE_CODEX_SOCKET", filepath.Join(root, "control.sock"))
	env.Chdir(root)
	a := testApp(t, env)
	source := repoRoot(t)
	// Install a private copy, including the same generation marker setup uses.
	candidate := filepath.Join(root, "source")
	for _, name := range []string{".claude-plugin", "claude-plugin"} {
		if err := copyTree(filepath.Join(source, name), filepath.Join(candidate, name)); err != nil {
			t.Fatal(err)
		}
	}
	identity, err := a.localPluginGeneration(source, candidate)
	if err != nil {
		t.Fatal(err)
	}
	if err := sealPluginGeneration(candidate, identity); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"plugin", "marketplace", "add", candidate}, {"plugin", "add", codexPluginRef}} {
		out, err := a.runCodexCLIQuiet(args...)
		if err != nil {
			t.Fatalf("codex %v: %v\n%s", args, err, out)
		}
	}
	observer, err := a.openCodexTrustRPC()
	if err != nil {
		t.Fatal(err)
	}
	defer observer.close()
	list := func() []codexTrustHook {
		t.Helper()
		hooks, err := a.listFeltCodexHooks(observer)
		if err != nil {
			t.Fatal(err)
		}
		return hooks
	}
	initial := list()
	if len(initial) == 0 {
		t.Fatal("Codex did not discover the private felt plugin's hooks")
	}
	loaded := filepath.Dir(filepath.Dir(initial[0].SourcePath))
	if err := requireFeltCodexTrust(initial); err == nil {
		t.Fatal("fresh plugin is already trusted")
	}
	quoted, _ := json.Marshal(initial[0].Key)
	var result json.RawMessage
	if err := observer.call("config/batchWrite", map[string]any{"edits": []any{
		map[string]any{"keyPath": "hooks.state." + string(quoted) + ".enabled", "value": false, "mergeStrategy": "upsert"},
		map[string]any{"keyPath": `hooks.state."other@market:hooks/hooks.json:0:0".trusted_hash`, "value": "leave-alone", "mergeStrategy": "upsert"},
	}}, &result); err != nil {
		t.Fatal(err)
	}
	// With no socket, setup uses an ephemeral stdio server. An observer that
	// was already running must see the write without being reinitialized.
	if err := a.codexHookTrust(true); err != nil {
		t.Fatal(err)
	}
	if err := requireFeltCodexTrust(list()); err != nil {
		t.Fatalf("ephemeral write was not visible: %v", err)
	}
	markerPath := filepath.Join(loaded, pluginGenerationMarkerName)
	marker, err := os.ReadFile(markerPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(markerPath, append(marker, '\n'), 0644); err != nil {
		t.Fatal(err)
	}

	// A real, isolated long-lived Unix App Server proves the WebSocket verification
	// path and stays up through every write.
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	server := env.CommandContext(ctx, "codex", "app-server", "--listen", "unix://"+env.Getenv("SHUTTLE_CODEX_SOCKET"))
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cancel(); server.Wait() }()
	poll := time.NewTicker(10 * time.Millisecond)
	defer poll.Stop()
	for {
		if _, err := os.Stat(env.Getenv("SHUTTLE_CODEX_SOCKET")); err == nil {
			break
		}
		select {
		case <-poll.C:
		case <-ctx.Done():
			t.Fatal("private Codex server did not create its socket")
		}
	}
	if err := a.codexHookTrust(false); err == nil {
		t.Fatal("live server accepted untrusted hooks")
	}
	if err := a.codexHookTrust(true); err != nil {
		t.Fatal(err)
	}
	if err := requireFeltCodexTrust(list()); err != nil {
		t.Fatalf("already running stdio server did not reread trust: %v", err)
	}
	if err := a.codexHookTrust(false); err != nil {
		t.Fatal(err)
	}
	if err := a.codexHookTrust(true); err != nil {
		t.Fatalf("idempotent trust: %v", err)
	}

	// Reinstalling identical bytes, including the marker, preserves both hashes.
	if err := os.WriteFile(filepath.Join(candidate, "claude-plugin", pluginGenerationMarkerName), append(marker, '\n'), 0644); err != nil {
		t.Fatal(err)
	}
	before := list()
	if _, err := a.runCodexCLIQuiet("plugin", "remove", codexPluginRef); err != nil {
		t.Fatal(err)
	}
	if _, err := a.runCodexCLIQuiet("plugin", "add", codexPluginRef); err != nil {
		t.Fatal(err)
	}
	for i, h := range list() {
		if h.CurrentHash != before[i].CurrentHash || h.TrustStatus != "trusted" {
			t.Fatalf("identical reinstall invalidates trust: %#v", h)
		}
	}
	mutations := []struct {
		name   string
		mutate func()
	}{
		{"generation marker", func() {
			identity.ResolvedCommit = strings.Repeat("f", 40)
			if err := writePluginGeneration(candidate, identity); err != nil {
				t.Fatal(err)
			}
			data, _ := os.ReadFile(filepath.Join(candidate, "claude-plugin", pluginGenerationMarkerName))
			if err := os.WriteFile(filepath.Join(loaded, pluginGenerationMarkerName), data, 0644); err != nil {
				t.Fatal(err)
			}
		}},
		{"unrelated file", func() {
			if err := os.WriteFile(filepath.Join(loaded, "unused.txt"), []byte("content"), 0644); err != nil {
				t.Fatal(err)
			}
		}},
		{"hook script", func() {
			path := filepath.Join(loaded, "hooks", "session.sh")
			data, _ := os.ReadFile(path)
			if err := os.WriteFile(path, append(data, []byte("\n# content change\n")...), 0755); err != nil {
				t.Fatal(err)
			}
		}},
		{"hook definition", func() {
			path := filepath.Join(loaded, "hooks", "hooks.json")
			data, _ := os.ReadFile(path)
			data = []byte(strings.ReplaceAll(string(data), `"command": "`, `"command": "true && `))
			if err := os.WriteFile(path, data, 0644); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for _, m := range mutations {
		before := list()
		m.mutate()
		after := list()
		if m.name == "hook definition" {
			fresh, err := a.openCodexTrustRPC()
			if err != nil {
				t.Fatal(err)
			}
			after, err = a.listFeltCodexHooks(fresh)
			fresh.close()
			if err != nil {
				t.Fatal(err)
			}
		}
		if after[0].CurrentHash == before[0].CurrentHash {
			t.Fatalf("%s not reflected in Codex hash", m.name)
		}
		oldDefinition, oldContent, _ := codexTrustHashes(before[0].CurrentHash)
		newDefinition, newContent, _ := codexTrustHashes(after[0].CurrentHash)
		if oldContent == newContent {
			t.Fatalf("%s did not change content hash", m.name)
		}
		if m.name == "hook definition" {
			if oldDefinition == newDefinition {
				t.Fatal("definition edit did not change definition hash")
			}
		} else if oldDefinition != newDefinition {
			t.Fatalf("%s changed hook definition hash", m.name)
		}
		if err := a.codexHookTrust(false); err == nil {
			t.Fatalf("receipt accepted %s mutation", m.name)
		}
		if err := a.codexHookTrust(true); err != nil {
			t.Fatalf("repairing %s trust: %v", m.name, err)
		}
		if err := a.codexHookTrust(false); err != nil {
			t.Fatal(err)
		}
	}
	configData, err := os.ReadFile(filepath.Join(root, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Hooks struct {
			State map[string]map[string]any `toml:"state"`
		} `toml:"hooks"`
	}
	if err := toml.Unmarshal(configData, &config); err != nil {
		t.Fatal(err)
	}
	if config.Hooks.State[initial[0].Key]["enabled"] != false {
		t.Fatal("trust changed the hook's disabled preference")
	}
	if config.Hooks.State["other@market:hooks/hooks.json:0:0"]["trusted_hash"] != "leave-alone" {
		t.Fatal("trust changed another plugin's approval")
	}
	// The exact number varies with Codex's supported hook events.
	t.Logf("Codex trust verified for %d hooks; stdio persistence, live socket, identical reinstall, marker/content/definition invalidation", len(initial))
}
