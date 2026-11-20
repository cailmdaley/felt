package feltcli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// TestCodexMarketplaceSource pins the one translation felt does at the Codex
// boundary: the two CLIs spell a pinned ref differently (`#tag` vs `@tag`) and
// defaultMarketplaceRef() emits Claude's form. Local paths pass through — Codex
// accepts a directory marketplace directly.
func TestCodexMarketplaceSource(t *testing.T) {
	t.Parallel()
	cases := []struct{ in, want string }{
		{"/home/dev/code/felt", "/home/dev/code/felt"},         // local abs path → unchanged
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
	t.Parallel()
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
		"Added marketplace `cailmdaley-felt` from /home/dev/code/felt.\n",
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
	t.Parallel()
	root := repoRoot(t)

	// The repo should have a claude-plugin/plugin.json.
	env, _ := testEnv(t)
	pluginDir, err := testApp(t, env).findPluginDir(root)
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
	t.Parallel()
	repoRoot, expectedPluginDir := scaffoldRepoLayout(t)

	env, _ := testEnv(t)
	pluginDir, err := testApp(t, env).findPluginDir(repoRoot)
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
	t.Parallel()
	_, pluginDir := scaffoldRepoLayout(t)

	env, _ := testEnv(t)
	env.Set("FELT_PLUGIN_DIR", pluginDir)

	resolved, err := testApp(t, env).findPluginDir("")
	if err != nil {
		t.Fatalf("findPluginDir (env): %v", err)
	}
	if resolved != pluginDir {
		t.Fatalf("expected %s, got %s", pluginDir, resolved)
	}
}

// fakeClaudeOnPath puts a stub `claude` first on env's PATH. The stub logs
// every invocation, answers `plugin list --json` with listJSON, and answers
// `plugin marketplace list --json` with the felt marketplace already
// registered — the state every caller of installPluginViaCLI is really in,
// since setup registers the marketplace before it installs anything. Returns
// a func reading the log.
func fakeClaudeOnPath(t *testing.T, env *sysenv.Env, listJSON string) func() string {
	t.Helper()
	marketplaceJSON := `[{"name":"` + marketplaceName + `","source":"directory","path":"/tmp/felt-repo"}]`
	return fakeCallLog(t, env, "claude",
		"if [ \"$1\" = plugin ] && [ \"$2\" = marketplace ] && [ \"$3\" = list ]; then\n"+
			"  cat <<'JSON'\n"+marketplaceJSON+"\nJSON\n"+
			"elif [ \"$1\" = plugin ] && [ \"$2\" = list ]; then\n"+
			"  cat <<'JSON'\n"+listJSON+"\nJSON\n"+
			"fi\n")
}

func TestPruneLegacyClaudeHooks(t *testing.T) {
	t.Parallel()
	env, _ := testEnv(t)
	settingsDir := filepath.Join(homeOf(t, env), ".claude")
	if err := os.MkdirAll(settingsDir, 0o755); err != nil {
		t.Fatal(err)
	}

	settings := map[string]interface{}{
		"model": "sonnet",
		"hooks": map[string]interface{}{
			"PostToolUse": []interface{}{
				map[string]interface{}{"hooks": []interface{}{
					map[string]interface{}{
						"type": "command", "command": "/Users/cail/loom/hooks/shuttle-hook.sh",
					},
					map[string]interface{}{
						"type": "command", "command": "/Users/cail/bin/keep-me.sh",
					},
				}},
				map[string]interface{}{"hooks": []interface{}{map[string]interface{}{
					"type": "command", "command": "/repo/claude-plugin/hooks/event.sh",
				}}},
			},
			"SessionStart": []interface{}{
				map[string]interface{}{"hooks": []interface{}{map[string]interface{}{
					"type": "command", "command": "/Users/cail/loom/hooks/shuttle-hook.sh",
				}}},
			},
		},
	}
	data, err := json.Marshal(settings)
	if err != nil {
		t.Fatal(err)
	}
	settingsPath := filepath.Join(settingsDir, "settings.json")
	if err := os.WriteFile(settingsPath, data, 0o644); err != nil {
		t.Fatal(err)
	}

	if got := testApp(t, env).pruneLegacyClaudeHooks(); got != 2 {
		t.Fatalf("pruneLegacyClaudeHooks() = %d, want 2", got)
	}

	var cleaned map[string]interface{}
	cleanedData, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(cleanedData, &cleaned); err != nil {
		t.Fatal(err)
	}
	if cleaned["model"] != "sonnet" {
		t.Fatalf("unrelated settings changed: %#v", cleaned["model"])
	}
	hooks := cleaned["hooks"].(map[string]interface{})
	if _, ok := hooks["SessionStart"]; ok {
		t.Fatalf("legacy-only SessionStart entry survived: %#v", hooks["SessionStart"])
	}
	post := hooks["PostToolUse"].([]interface{})
	if len(post) != 2 {
		t.Fatalf("unrelated PostToolUse entry was removed: %#v", post)
	}
	if len(post) == 2 {
		first := post[0].(map[string]interface{})["hooks"].([]interface{})
		if len(first) != 1 || first[0].(map[string]interface{})["command"] != "/Users/cail/bin/keep-me.sh" {
			t.Fatalf("unrelated command in a shared hook group was removed: %#v", first)
		}
	}
}

// TestInstallPluginViaCLI_OpFollowsPluginNotMarketplace pins the fix for a
// setup that could not recover from a registered-but-not-installed state — a
// marketplace add that succeeded followed by an install that didn't, or a
// hand-run `claude plugin marketplace add`. Choosing install-vs-update by
// marketplace registration sent the next setup to `claude plugin update`,
// which hard-fails on a plugin that isn't installed. The op must follow
// whether the PLUGIN is installed.
func TestInstallPluginViaCLI_OpFollowsPluginNotMarketplace(t *testing.T) {
	t.Parallel()
	pluginRef := "felt@" + marketplaceName

	t.Run("plugin absent → install", func(t *testing.T) {
		// A registered marketplace with no felt plugin: the state an install
		// that failed after `marketplace add` leaves behind.
		t.Parallel()
		env, _ := testEnv(t)
		calls := fakeClaudeOnPath(t, env, `[{"id":"other@somewhere"}]`)
		if err := testApp(t, env).installClaudePluginAtSource("/tmp/felt-repo"); err != nil {
			t.Fatalf("install: %v", err)
		}
		if got := calls(); !strings.Contains(got, "plugin install "+pluginRef) {
			t.Errorf("expected `plugin install`, got calls:\n%s", got)
		}
	})

	t.Run("plugin present → update", func(t *testing.T) {
		t.Parallel()
		env, _ := testEnv(t)
		calls := fakeClaudeOnPath(t, env, `[{"id":"`+pluginRef+`"}]`)
		if err := testApp(t, env).installClaudePluginAtSource("/tmp/felt-repo"); err != nil {
			t.Fatalf("install: %v", err)
		}
		if got := calls(); !strings.Contains(got, "plugin update "+pluginRef) {
			t.Errorf("expected `plugin update`, got calls:\n%s", got)
		}
	})

	t.Run("unreadable plugin list → install", func(t *testing.T) {
		// Install is the safe guess: installing an installed plugin is a
		// no-op, updating a missing one is an error.
		t.Parallel()
		env, _ := testEnv(t)
		calls := fakeClaudeOnPath(t, env, `not json`)
		if err := testApp(t, env).installClaudePluginAtSource("/tmp/felt-repo"); err != nil {
			t.Fatalf("install: %v", err)
		}
		if got := calls(); !strings.Contains(got, "plugin install "+pluginRef) {
			t.Errorf("expected `plugin install`, got calls:\n%s", got)
		}
	})
}

// TestUninstallPluginRemovesMarketplaceAndSkillLinks: `felt uninstall` is the
// inverse of `felt setup claude` as well as of `felt setup codex`, so it
// removes the cailmdaley-felt marketplace from ~/.claude/settings.json along
// with the plugin. The marketplace declares exactly one plugin, so nothing
// else is hanging off it — and the skills `felt setup skills` linked out of its clone
// have to be unlinked first, or removing the clone leaves dangling symlinks.
func TestUninstallPluginRemovesMarketplaceAndSkillLinks(t *testing.T) {
	t.Parallel()
	env, _ := testEnv(t)
	home := homeOf(t, env)
	calls := fakeClaudeOnPath(t, env, `[{"id":"felt@`+marketplaceName+`"}]`)

	// Skills linked from the marketplace clone and from the plugin runtime
	// the directory marketplace serves (both go), one linked from a local
	// checkout (stays — its target survives uninstall), and a real directory
	// (never ours to touch).
	cloneSkills := filepath.Join(home, ".claude", "plugins", "marketplaces", marketplaceName, "claude-plugin", "skills", "felt")
	runtimeSkill := filepath.Join(home, ".felt", pluginRuntimeDirName, pluginCurrentName, "claude-plugin", "skills", "shuttle")
	checkoutSkill := filepath.Join(home, "src", "felt", "claude-plugin", "skills", "shuttle")
	skillsDir := filepath.Join(home, ".claude", "skills")
	for _, d := range []string{cloneSkills, runtimeSkill, checkoutSkill, skillsDir, filepath.Join(skillsDir, "unrelated")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// Two links whose text starts inside the runtime but which land outside
	// it, through .. and through a further symlink: both stay.
	runtimeDir := filepath.Join(home, ".felt", pluginRuntimeDirName)
	localSkill := filepath.Join(home, "src", "local")
	if err := os.MkdirAll(localSkill, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(home, "src"), filepath.Join(runtimeDir, "external")); err != nil {
		t.Fatal(err)
	}
	escapes := map[string]string{
		"dotdot":  runtimeDir + "/../../src/local", // unjoined, so the .. survives in the link text
		"through": filepath.Join(runtimeDir, "external", "local"),
	}
	for link, target := range map[string]string{"felt": cloneSkills, "shuttle": runtimeSkill, "shuttle-dev": checkoutSkill, "dotdot": escapes["dotdot"], "through": escapes["through"]} {
		if err := os.Symlink(target, filepath.Join(skillsDir, link)); err != nil {
			t.Fatal(err)
		}
	}

	if err := testApp(t, env).uninstallPlugin(); err != nil {
		t.Fatalf("uninstallPlugin: %v", err)
	}

	got := calls()
	uninstall := strings.Index(got, "plugin uninstall felt@"+marketplaceName)
	removeMarket := strings.Index(got, "plugin marketplace remove "+marketplaceName)
	if uninstall < 0 {
		t.Errorf("expected `plugin uninstall`, got calls:\n%s", got)
	}
	if removeMarket < 0 {
		t.Errorf("expected `plugin marketplace remove`, got calls:\n%s", got)
	}
	if uninstall >= 0 && removeMarket >= 0 && removeMarket < uninstall {
		t.Errorf("marketplace removed before the plugin it hosts:\n%s", got)
	}

	if _, err := os.Lstat(filepath.Join(skillsDir, "felt")); !os.IsNotExist(err) {
		t.Errorf("skill linked from the marketplace clone survived uninstall: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(skillsDir, "shuttle")); !os.IsNotExist(err) {
		t.Errorf("skill linked from the plugin runtime survived uninstall: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(skillsDir, "shuttle-dev")); err != nil {
		t.Errorf("skill linked from a local checkout was removed: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(skillsDir, "unrelated")); err != nil {
		t.Errorf("unrelated skill directory was removed: %v", err)
	}
	for link := range escapes {
		if _, err := os.Lstat(filepath.Join(skillsDir, link)); err != nil {
			t.Errorf("link %q resolving outside the runtime was removed: %v", link, err)
		}
	}
}
