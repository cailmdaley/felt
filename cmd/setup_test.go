package cmd

import (
	"os"
	"path/filepath"
	"testing"
)

// TestFindPluginDir verifies the resolver returns a valid plugin directory
// from a --source path pointing at a felt repo checkout.
func TestFindPluginDir_FromRepoCheckout(t *testing.T) {
	// Find repo root by walking up from cwd.
	root, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(root, "go.mod")); err == nil {
			break
		}
		parent := filepath.Dir(root)
		if parent == root {
			t.Fatal("could not find repo root with go.mod")
		}
		root = parent
	}

	// The repo should have a claude-plugin/plugin.json.
	pluginDir, err := findPluginDir(root)
	if err != nil {
		t.Fatalf("findPluginDir(%s): %v", root, err)
	}
	if _, err := os.Stat(filepath.Join(pluginDir, ".claude-plugin", "plugin.json")); err != nil {
		t.Fatalf("expected .claude-plugin/plugin.json in resolved dir %s: %v", pluginDir, err)
	}
}

// TestFindPluginDir_DirectPlugin verifies the resolver accepts a path that IS
// the plugin directory (has .claude-plugin/plugin.json).
func TestFindPluginDir_DirectPlugin(t *testing.T) {
	tmp := t.TempDir()
	if err := os.MkdirAll(filepath.Join(tmp, ".claude-plugin"), 0755); err != nil {
		t.Fatalf("mkdir .claude-plugin: %v", err)
	}
	if err := os.WriteFile(filepath.Join(tmp, ".claude-plugin", "plugin.json"), []byte(`{}`), 0644); err != nil {
		t.Fatalf("write plugin.json: %v", err)
	}

	pluginDir, err := findPluginDir(tmp)
	if err != nil {
		t.Fatalf("findPluginDir(%s): %v", tmp, err)
	}
	if pluginDir != tmp {
		t.Fatalf("expected %s, got %s", tmp, pluginDir)
	}
}

// TestFindPluginDir_EnvVar verifies $FELT_PLUGIN_DIR is honoured when no source is given.
func TestFindPluginDir_EnvVar(t *testing.T) {
	tmp := t.TempDir()
	if err := os.MkdirAll(filepath.Join(tmp, ".claude-plugin"), 0755); err != nil {
		t.Fatalf("mkdir .claude-plugin: %v", err)
	}
	if err := os.WriteFile(filepath.Join(tmp, ".claude-plugin", "plugin.json"), []byte(`{}`), 0644); err != nil {
		t.Fatalf("write plugin.json: %v", err)
	}

	t.Setenv("FELT_PLUGIN_DIR", tmp)

	pluginDir, err := findPluginDir("")
	if err != nil {
		t.Fatalf("findPluginDir (env): %v", err)
	}
	if pluginDir != tmp {
		t.Fatalf("expected %s, got %s", tmp, pluginDir)
	}
}
