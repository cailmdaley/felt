package feltcli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// `felt setup antigravity` writes a native agy plugin agy loads: plugin.json
// and hooks.json at its root, the shim the hooks run, and the felt and
// shuttle skills; it replaces only plugins/felt/, and --uninstall removes it.
func TestSetupAntigravityInstallsTheNativePlugin(t *testing.T) {
	t.Parallel()
	env, _ := testEnv(t)
	home := homeOf(t, env)
	sibling := filepath.Join(home, ".gemini", "config", "plugins", "loom", "plugin.json")
	if err := os.MkdirAll(filepath.Dir(sibling), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sibling, []byte(`{"name":"loom"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(home, ".gemini", "config", "plugins", "felt")
	stale := filepath.Join(dir, "skills", "retired", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(stale), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stale, nil, 0o644); err != nil {
		t.Fatal(err)
	}

	for range 2 {
		if _, stderr, err := executeIn(t, env, t.TempDir(), "setup", "antigravity", "--source", repoRoot(t)); err != nil {
			t.Fatalf("setup: %v %s", err, stderr)
		}
	}

	var manifest map[string]string
	readJSON(t, filepath.Join(dir, "plugin.json"), &manifest)
	if manifest["name"] != "felt" {
		t.Fatalf("plugin.json = %v", manifest)
	}
	var hooks map[string]map[string][]map[string]any
	readJSON(t, filepath.Join(dir, "hooks.json"), &hooks)
	events := hooks["felt-shuttle"]
	for _, flat := range []string{"SessionStart", "PreInvocation", "Stop"} {
		if len(events[flat]) != 1 || events[flat][0]["command"] != "./hooks/agy.sh" {
			t.Fatalf("%s handlers = %v", flat, events[flat])
		}
	}
	for _, tool := range []string{"PreToolUse", "PostToolUse"} {
		if len(events[tool]) != 1 || events[tool][0]["matcher"] != "*" || events[tool][0]["hooks"] == nil {
			t.Fatalf("%s groups = %v", tool, events[tool])
		}
		if handlers, _ := events[tool][0]["hooks"].([]any); len(handlers) != 1 ||
			handlers[0].(map[string]any)["command"] != "./hooks/agy.sh tool" {
			t.Fatalf("%s handlers = %v", tool, events[tool][0]["hooks"])
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "hooks", "hooks.json")); !os.IsNotExist(err) {
		t.Fatalf("Claude's hooks.json was copied into the agy plugin: %v", err)
	}
	for _, path := range []string{"hooks/agy.sh", "hooks/shuttle-bin.sh", "skills/felt/SKILL.md", "skills/shuttle/SKILL.md"} {
		if _, err := os.Stat(filepath.Join(dir, path)); err != nil {
			t.Fatalf("plugin lacks %s: %v", path, err)
		}
	}
	if info, err := os.Stat(filepath.Join(dir, "hooks", "agy.sh")); err != nil || info.Mode().Perm()&0o100 == 0 {
		t.Fatalf("hook shim is not executable: %v %v", info, err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("a retired skill survived the reinstall: %v", err)
	}
	if _, err := os.Stat(dir + ".new"); !os.IsNotExist(err) {
		t.Fatal("staging directory left behind")
	}

	if _, _, err := executeIn(t, env, t.TempDir(), "setup", "antigravity", "--uninstall"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("plugin survived --uninstall: %v", err)
	}
	if _, err := os.Stat(sibling); err != nil {
		t.Fatalf("another plugin was touched: %v", err)
	}
}

func readJSON(t *testing.T, path string, v any) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
}

// A plugin source from before the agy shim installs nothing, rather than hooks
// that run a missing command.
func TestSetupAntigravityRefusesASourceWithoutTheShim(t *testing.T) {
	t.Parallel()
	env, _ := testEnv(t)
	source := t.TempDir()
	for _, path := range []string{".claude-plugin/marketplace.json", "claude-plugin/hooks/event.sh", "claude-plugin/skills/felt/SKILL.md"} {
		if err := os.MkdirAll(filepath.Join(source, filepath.Dir(path)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(source, path), []byte("{}"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := executeIn(t, env, t.TempDir(), "setup", "antigravity", "--source", source); err == nil || !strings.Contains(err.Error(), "agy.sh") {
		t.Fatalf("setup from a source without the shim: %v", err)
	}
	if _, err := os.Stat(filepath.Join(homeOf(t, env), ".gemini", "config", "plugins", "felt")); !os.IsNotExist(err) {
		t.Fatalf("a plugin was installed: %v", err)
	}
}
