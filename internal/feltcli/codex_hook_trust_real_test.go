package feltcli

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
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
	codexHome := filepath.Join(root, "codex")
	if err := os.MkdirAll(codexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(root, "control.sock")
	env.Set("HOME", root)
	env.Set("CODEX_HOME", codexHome)
	env.Set("SHUTTLE_CODEX_SOCKET", socket)
	// Setup may run from a project; trust must not depend on it.
	env.Chdir(repoRoot(t))
	a := testApp(t, env)
	source := repoRoot(t)
	// Promote a private sealed generation where setup puts it.
	candidate := filepath.Join(root, ".felt", pluginRuntimeDirName, pluginCurrentName)
	plugin := filepath.Join(candidate, "claude-plugin")
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
	reseal := func() {
		t.Helper()
		digest, err := pluginPayloadDigest(plugin)
		if err != nil {
			t.Fatal(err)
		}
		identity.PayloadSHA256 = digest
		if err := writePluginGeneration(candidate, identity); err != nil {
			t.Fatal(err)
		}
	}
	reinstall := func() {
		t.Helper()
		for _, args := range [][]string{{"plugin", "remove", codexPluginRef}, {"plugin", "add", codexPluginRef}} {
			if out, err := a.runCodexCLIQuiet(args...); err != nil {
				t.Fatalf("codex %v: %v\n%s", args, err, out)
			}
		}
	}
	if out, err := a.runCodexCLIQuiet("plugin", "marketplace", "add", candidate); err != nil {
		t.Fatalf("codex marketplace add: %v\n%s", err, out)
	}
	if out, err := a.runCodexCLIQuiet("plugin", "add", codexPluginRef); err != nil {
		t.Fatalf("codex plugin add: %v\n%s", err, out)
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
	if cache, err := a.verifiedCodexCacheRoot(); err != nil || cache != loaded {
		t.Fatalf("verified cache %q (%v) is not the root Codex loads, %q", cache, err, loaded)
	}
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
	configPath := filepath.Join(codexHome, "config.toml")

	// Laundering control: bytes in the cache that are not the promoted
	// generation get no trust, and the config is not touched.
	script := filepath.Join(loaded, "hooks", "session.sh")
	original, err := os.ReadFile(script)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(script, append(bytes.Clone(original), []byte("\necho tampered\n")...), 0o755); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(configPath)
	if r := a.codexHookTrust(true); r.State != codexTrustUnverified {
		t.Fatalf("tampered cache = %+v, want unverified", r)
	}
	if after, _ := os.ReadFile(configPath); !bytes.Equal(before, after) {
		t.Fatal("tampered cache changed the Codex config")
	}
	if err := os.WriteFile(script, original, 0o755); err != nil {
		t.Fatal(err)
	}

	// A stale socket left by a dead server: the ephemeral stdio server writes
	// and verifies, the live server is uninspected, and an observer that was
	// already running sees the write without being reinitialized.
	stale, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	stale.(*net.UnixListener).SetUnlinkOnClose(false)
	stale.Close()
	if r := a.codexHookTrust(true); r.State != codexTrustTrusted || r.Live != codexLiveUninspected {
		t.Fatalf("stale socket trust = %+v", r)
	}
	if err := requireFeltCodexTrust(list()); err != nil {
		t.Fatalf("ephemeral write was not visible: %v", err)
	}
	os.Remove(socket)

	// A real, isolated long-lived Unix App Server proves the WebSocket path
	// and stays up through every write.
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	server := env.CommandContext(ctx, "codex", "app-server", "--listen", "unix://"+socket)
	server.Dir = root
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cancel(); server.Wait() }()
	poll := time.NewTicker(10 * time.Millisecond)
	defer poll.Stop()
	for {
		if _, err := os.Stat(socket); err == nil {
			break
		}
		select {
		case <-poll.C:
		case <-ctx.Done():
			t.Fatal("private Codex server did not create its socket")
		}
	}
	if r := a.codexHookTrust(false); r.State != codexTrustTrusted || r.Live != codexLiveVerified {
		t.Fatalf("live view of trusted hooks = %+v", r)
	}

	// Reinstalling identical bytes, including the marker, preserves both hashes.
	unchanged := list()
	reinstall()
	for i, h := range list() {
		if h.CurrentHash != unchanged[i].CurrentHash || h.TrustStatus != "trusted" {
			t.Fatalf("identical reinstall invalidates trust: %#v", h)
		}
	}
	// Each change goes through the promoted source and a reinstall, as setup
	// delivers it.
	mutations := []struct {
		name   string
		mutate func()
	}{
		{"generation marker", func() {
			identity.ResolvedCommit = strings.Repeat("f", 40)
			if err := writePluginGeneration(candidate, identity); err != nil {
				t.Fatal(err)
			}
		}},
		{"unrelated file", func() {
			if err := os.WriteFile(filepath.Join(plugin, "unused.txt"), []byte("content"), 0o644); err != nil {
				t.Fatal(err)
			}
			reseal()
		}},
		{"hook script", func() {
			path := filepath.Join(plugin, "hooks", "session.sh")
			data, _ := os.ReadFile(path)
			if err := os.WriteFile(path, append(data, []byte("\n# content change\n")...), 0o755); err != nil {
				t.Fatal(err)
			}
			reseal()
		}},
		{"hook definition", func() {
			path := filepath.Join(plugin, "hooks", "hooks.json")
			data, _ := os.ReadFile(path)
			data = []byte(strings.ReplaceAll(string(data), `"command": "`, `"command": "true && `))
			if err := os.WriteFile(path, data, 0o644); err != nil {
				t.Fatal(err)
			}
			reseal()
		}},
	}
	for _, m := range mutations {
		before := list()
		m.mutate()
		reinstall()
		after := list()
		if m.name == "hook definition" {
			// A running server keeps the definitions it loaded.
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
		if r := a.codexHookTrust(false); r.State != codexTrustFailed {
			t.Fatalf("receipt accepted %s mutation: %+v", m.name, r)
		}
		if r := a.codexHookTrust(true); r.State != codexTrustTrusted || r.Live != codexLiveVerified {
			t.Fatalf("repairing %s trust: %+v", m.name, r)
		}
		if r := a.codexHookTrust(false); r.State != codexTrustTrusted {
			t.Fatalf("after %s repair: %+v", m.name, r)
		}
	}
	configData, err := os.ReadFile(configPath)
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
	t.Logf("Codex trust verified for %d hooks; laundering refusal, stale socket, stdio persistence, live socket, identical reinstall, marker/content/definition invalidation", len(initial))
}
