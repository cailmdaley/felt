package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestCodexMarketplaceSource pins the one translation felt does at the Codex
// boundary: the two CLIs spell a pinned ref differently (`#tag` vs `@tag`) and
// defaultMarketplaceRef() emits Claude's form. Local paths pass through — Codex
// accepts a directory marketplace directly.
func TestCodexMarketplaceSource(t *testing.T) {
	cases := []struct{ in, want string }{
		{"/home/cdaley/code/felt", "/home/cdaley/code/felt"},   // local abs path → unchanged
		{"./felt", "./felt"},                                   // local rel path → unchanged
		{"cailmdaley/felt", "cailmdaley/felt"},                 // bare repo ref → unchanged
		{"cailmdaley/felt#v1.0.14", "cailmdaley/felt@v1.0.14"}, // git ref → #→@
	}
	for _, tc := range cases {
		if got := codexMarketplaceSource(tc.in); got != tc.want {
			t.Errorf("codexMarketplaceSource(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// TestCodexMarketplaceConflict guards the discriminator that decides whether
// repointCodexMarketplace may unregister felt's marketplace. Only a refusal
// naming *felt's own* marketplace earns that; anything else must leave a working
// registration alone, so a false positive here loses a user's install on a
// network blip or on a conflict about an unrelated marketplace. The first case
// is codex 0.147.0's message verbatim.
func TestCodexMarketplaceConflict(t *testing.T) {
	conflicts := []string{
		"Error: marketplace 'cailmdaley-felt' is already added from a different source; remove it before adding this source\n",
	}
	for _, out := range conflicts {
		if !codexMarketplaceConflict(out) {
			t.Errorf("codexMarketplaceConflict(%q) = false, want true", out)
		}
	}

	benign := []string{
		"",
		// A collision on somebody else's marketplace is not licence to
		// unregister ours.
		"Error: marketplace 'otherplace' is already added from a different source; remove it before adding this source\n",
		"Error: git checkout v9.9.9 failed: pathspec 'v9.9.9' did not match any file(s) known to git\n",
		"Error: failed to fetch https://github.com/cailmdaley/felt.git: could not resolve host\n",
		"error: unrecognized subcommand 'add'\n",
		"Added marketplace `cailmdaley-felt` from /home/cdaley/code/felt.\n",
	}
	for _, out := range benign {
		if codexMarketplaceConflict(out) {
			t.Errorf("codexMarketplaceConflict(%q) = true, want false", out)
		}
	}
}

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

// fakeClaudeOnPath puts a stub `claude` at the front of PATH for the duration
// of the test. The stub appends every invocation to a log file, answers
// `plugin list --json` with listJSON, and answers `plugin marketplace list
// --json` with the felt marketplace already registered — the state every
// caller of installPluginViaCLI is really in, since setup registers the
// marketplace on first run and uninstall never removes it. Returns a func
// reading the log.
func fakeClaudeOnPath(t *testing.T, listJSON string) func() string {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "calls.log")
	marketplaceJSON := `[{"name":"` + marketplaceName + `","source":"directory","path":"/tmp/felt-repo"}]`
	script := "#!/bin/sh\n" +
		"echo \"$@\" >> " + log + "\n" +
		"if [ \"$1\" = plugin ] && [ \"$2\" = marketplace ] && [ \"$3\" = list ]; then\n" +
		"  cat <<'JSON'\n" + marketplaceJSON + "\nJSON\n" +
		"elif [ \"$1\" = plugin ] && [ \"$2\" = list ]; then\n" +
		"  cat <<'JSON'\n" + listJSON + "\nJSON\n" +
		"fi\n" +
		"exit 0\n"
	if err := os.WriteFile(filepath.Join(dir, "claude"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return func() string {
		b, err := os.ReadFile(log)
		if err != nil {
			return ""
		}
		return string(b)
	}
}

// TestInstallPluginViaCLI_OpFollowsPluginNotMarketplace pins the fix for a
// setup that could not recover from its own uninstall. `felt setup claude
// --uninstall` leaves the marketplace registered on purpose, so choosing
// install-vs-update by marketplace registration sent the next setup to
// `claude plugin update` — which hard-fails on a plugin that isn't installed.
// The op must follow whether the PLUGIN is installed.
func TestInstallPluginViaCLI_OpFollowsPluginNotMarketplace(t *testing.T) {
	pluginRef := "felt@" + marketplaceName

	t.Run("plugin absent → install", func(t *testing.T) {
		// A registered marketplace with no felt plugin: exactly the state
		// `felt setup claude --uninstall` leaves behind.
		calls := fakeClaudeOnPath(t, `[{"id":"other@somewhere"}]`)
		if err := installPluginViaCLI("/tmp/felt-repo"); err != nil {
			t.Fatalf("install: %v", err)
		}
		if got := calls(); !strings.Contains(got, "plugin install "+pluginRef) {
			t.Errorf("expected `plugin install`, got calls:\n%s", got)
		}
	})

	t.Run("plugin present → update", func(t *testing.T) {
		calls := fakeClaudeOnPath(t, `[{"id":"`+pluginRef+`"}]`)
		if err := installPluginViaCLI("/tmp/felt-repo"); err != nil {
			t.Fatalf("install: %v", err)
		}
		if got := calls(); !strings.Contains(got, "plugin update "+pluginRef) {
			t.Errorf("expected `plugin update`, got calls:\n%s", got)
		}
	})

	t.Run("unreadable plugin list → install", func(t *testing.T) {
		// Install is the safe guess: installing an installed plugin is a
		// no-op, updating a missing one is an error.
		calls := fakeClaudeOnPath(t, `not json`)
		if err := installPluginViaCLI("/tmp/felt-repo"); err != nil {
			t.Fatalf("install: %v", err)
		}
		if got := calls(); !strings.Contains(got, "plugin install "+pluginRef) {
			t.Errorf("expected `plugin install`, got calls:\n%s", got)
		}
	})
}
