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

// scaffoldRepoLayout creates a tmp directory shaped like a felt repo:
//
//	<tmp>/
//	├── .claude-plugin/marketplace.json
//	└── claude-plugin/
//	    └── .claude-plugin/plugin.json
//
// Returns (repoRoot, pluginDir).
func scaffoldRepoLayout(t *testing.T) (string, string) {
	t.Helper()
	tmp := t.TempDir()
	if err := os.MkdirAll(filepath.Join(tmp, ".claude-plugin"), 0755); err != nil {
		t.Fatalf("mkdir marketplace .claude-plugin: %v", err)
	}
	if err := os.WriteFile(filepath.Join(tmp, ".claude-plugin", "marketplace.json"), []byte(`{"name":"test","plugins":[]}`), 0644); err != nil {
		t.Fatalf("write marketplace.json: %v", err)
	}
	pluginDir := filepath.Join(tmp, "claude-plugin")
	if err := os.MkdirAll(filepath.Join(pluginDir, ".claude-plugin"), 0755); err != nil {
		t.Fatalf("mkdir plugin .claude-plugin: %v", err)
	}
	if err := os.WriteFile(filepath.Join(pluginDir, ".claude-plugin", "plugin.json"), []byte(`{"name":"felt"}`), 0644); err != nil {
		t.Fatalf("write plugin.json: %v", err)
	}
	return tmp, pluginDir
}

// TestFindPluginDir_FromRepoRoot verifies the resolver returns the
// claude-plugin/ subdir when given the repo root (which has marketplace.json).
func TestFindPluginDir_FromRepoRoot(t *testing.T) {
	repoRoot, expectedPluginDir := scaffoldRepoLayout(t)

	pluginDir, err := findPluginDir(repoRoot)
	if err != nil {
		t.Fatalf("findPluginDir(%s): %v", repoRoot, err)
	}
	if pluginDir != expectedPluginDir {
		t.Fatalf("expected %s, got %s", expectedPluginDir, pluginDir)
	}
}

// TestFindPluginDir_EnvVar verifies $FELT_PLUGIN_DIR pointing at the plugin
// directory derives the marketplace root from its parent.
func TestFindPluginDir_EnvVar(t *testing.T) {
	_, pluginDir := scaffoldRepoLayout(t)

	t.Setenv("FELT_PLUGIN_DIR", pluginDir)

	resolved, err := findPluginDir("")
	if err != nil {
		t.Fatalf("findPluginDir (env): %v", err)
	}
	if resolved != pluginDir {
		t.Fatalf("expected %s, got %s", pluginDir, resolved)
	}
}
