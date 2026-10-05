package feltcli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// TestPiPackageSource pins the pi-side translation: pi's git shorthand needs
// the full github.com host, and a pinned Claude ref (`#v<tag>`) becomes pi's
// `@v<tag>`. Local paths pass through — pi installs a directory in place.
func TestPiPackageSource(t *testing.T) {
	t.Parallel()
	cases := []struct{ in, want string }{
		{"/home/dev/code/felt", "/home/dev/code/felt"},                        // local abs path → unchanged
		{"./felt", "./felt"},                                                  // local rel path → unchanged
		{"cailmdaley/felt", "git:github.com/cailmdaley/felt"},                 // bare repo ref → git shorthand
		{"cailmdaley/felt#v1.0.14", "git:github.com/cailmdaley/felt@v1.0.14"}, // pinned ref → host + @tag
	}
	for _, tc := range cases {
		if got := piPackageSource(tc.in); got != tc.want {
			t.Errorf("piPackageSource(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// TestSamePiSourceLocation pins the swap discriminator: git entries match on
// host+repo regardless of tag (a tag bump replaces in place, no removal),
// while a kind or location change (git↔local, two checkouts) counts as
// different — the old entry must be dropped first or pi loads felt twice.
func TestSamePiSourceLocation(t *testing.T) {
	t.Parallel()
	same := [][2]string{
		{"git:github.com/cailmdaley/felt", "git:github.com/cailmdaley/felt"},
		{"git:github.com/cailmdaley/felt", "git:github.com/cailmdaley/felt@v1.0.14"}, // tag bump
		{"/home/dev/code/felt", "/home/dev/code/felt"},
	}
	for _, pair := range same {
		if !samePiSourceLocation(pair[0], pair[1]) {
			t.Errorf("samePiSourceLocation(%q, %q) = false, want true", pair[0], pair[1])
		}
	}
	diff := [][2]string{
		{"git:github.com/cailmdaley/felt", "/home/dev/code/felt"}, // git→local (dev-source update)
		{"/home/dev/code/felt", "git:github.com/cailmdaley/felt"}, // local→git (tagged release)
		{"/home/dev/code/felt", "/home/dev/other-felt"},           // two dev checkouts
	}
	for _, pair := range diff {
		if samePiSourceLocation(pair[0], pair[1]) {
			t.Errorf("samePiSourceLocation(%q, %q) = true, want false", pair[0], pair[1])
		}
	}
}

// writePiSettings writes a ~/.pi/agent/settings.json under home with the given
// packages array.
func writePiSettings(t *testing.T, home string, packages []string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(home, ".pi", "agent"), 0o755); err != nil {
		t.Fatal(err)
	}
	pkgs, _ := json.Marshal(packages)
	settings := `{"packages":` + string(pkgs) + `}`
	if err := os.WriteFile(filepath.Join(home, ".pi", "agent", "settings.json"), []byte(settings), 0o644); err != nil {
		t.Fatal(err)
	}
}

// scaffoldFeltCheckout makes a directory holding a package.json named felt —
// what pi sees at the path of a local/dev install.
func scaffoldFeltCheckout(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"name":"felt","private":true}`), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestPiFeltPackageSource pins structural detection of the installed felt
// package: the git entry at any tag, and a local checkout recognized by its
// package.json name rather than its path. The substring probe this replaced
// was blind to local installs — refresh no-op'd and uninstall left residue —
// so the local cases here are the regression.
func TestPiFeltPackageSource(t *testing.T) {
	t.Parallel()
	const noRef = "git:github.com/cailmdaley/felt"

	for _, tc := range []struct {
		name string
		// arrange lays out home and returns the source piFeltPackageSource
		// should report.
		arrange func(t *testing.T, home string) string
	}{
		{"absent settings → empty", func(t *testing.T, home string) string { return "" }},
		{"no felt package → empty", func(t *testing.T, home string) string {
			writePiSettings(t, home, []string{"npm:pi-subagents", "/home/dev/unrelated"})
			return ""
		}},
		{"git bare", func(t *testing.T, home string) string {
			writePiSettings(t, home, []string{"npm:pi-subagents", noRef})
			return noRef
		}},
		{"git tagged", func(t *testing.T, home string) string {
			writePiSettings(t, home, []string{"npm:pi-subagents", noRef + "@v1.0.14"})
			return noRef + "@v1.0.14"
		}},
		{"local checkout by package name", func(t *testing.T, home string) string {
			checkout := filepath.Join(home, "dev", "felt")
			scaffoldFeltCheckout(t, checkout)
			writePiSettings(t, home, []string{checkout})
			return checkout
		}},
		{"home-relative local entry", func(t *testing.T, home string) string {
			scaffoldFeltCheckout(t, filepath.Join(home, "dev", "felt"))
			writePiSettings(t, home, []string{"dev/felt"})
			return "dev/felt"
		}},
		{"local dir without felt package.json → empty", func(t *testing.T, home string) string {
			other := filepath.Join(home, "dev", "other")
			scaffoldFeltCheckout(t, other)
			if err := os.WriteFile(filepath.Join(other, "package.json"), []byte(`{"name":"other"}`), 0o644); err != nil {
				t.Fatal(err)
			}
			writePiSettings(t, home, []string{other})
			return ""
		}},
		{"malformed settings → empty", func(t *testing.T, home string) string {
			if err := os.MkdirAll(filepath.Join(home, ".pi", "agent"), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(home, ".pi", "agent", "settings.json"), []byte("{not json"), 0o644); err != nil {
				t.Fatal(err)
			}
			return ""
		}},
		{"tilde entry expanded against home", func(t *testing.T, home string) string {
			scaffoldFeltCheckout(t, filepath.Join(home, "dev", "felt"))
			writePiSettings(t, home, []string{"~/dev/felt"})
			return "~/dev/felt"
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			env, _ := testEnv(t)
			want := tc.arrange(t, homeOf(t, env))
			if got := testApp(t, env).piFeltPackageSource(); got != want {
				t.Errorf("piFeltPackageSource() = %q, want %q", got, want)
			}
		})
	}
}

// TestInstallPiPackageViaCLI_SourceSwap pins the remove-before-install
// orchestration end to end: flipping samePiSourceLocation's negation would
// otherwise pass every pure-comparator test while duplicating felt in pi's
// settings. fakePiOnPath is the pi-side mirror of fakeClaudeOnPath.
func TestInstallPiPackageViaCLI_SourceSwap(t *testing.T) {
	t.Parallel()
	const gitSpec = "git:github.com/cailmdaley/felt"

	t.Run("orchestrator swaps a differing source before install", func(t *testing.T) {
		// Pins installPiPackageViaCLI's remove-before-install flow end to end:
		// flipping samePiSourceLocation's negation would otherwise pass every
		// pure-comparator test while duplicating felt in pi's settings.
		t.Parallel()
		env, _ := testEnv(t)
		home := homeOf(t, env)
		checkout := filepath.Join(home, "dev", "felt")
		scaffoldFeltCheckout(t, checkout)
		writePiSettings(t, home, []string{"npm:pi-subagents", checkout})
		calls := fakeCallLog(t, env, "pi", "")

		if err := testApp(t, env).installPiPackageViaCLI(gitSpec); err != nil {
			t.Fatalf("install: %v", err)
		}
		got := calls()
		remove := strings.Index(got, "remove "+checkout)
		install := strings.Index(got, "install "+gitSpec)
		if remove < 0 || install < 0 {
			t.Errorf("expected remove of %q then install, got calls:\n%s", checkout, got)
		} else if install < remove {
			t.Errorf("installed before removing the old source:\n%s", got)
		}
	})

	t.Run("same-source reinstall removes nothing", func(t *testing.T) {
		t.Parallel()
		env, _ := testEnv(t)
		writePiSettings(t, homeOf(t, env), []string{gitSpec})
		calls := fakeCallLog(t, env, "pi", "")

		if err := testApp(t, env).installPiPackageViaCLI(gitSpec + "@v1.2.3"); err != nil {
			t.Fatalf("install: %v", err)
		}
		if got := calls(); strings.Contains(got, "remove") {
			t.Errorf("tag bump should replace in place, got a remove:\n%s", got)
		}
	})
}

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

// TestUninstallPluginRemovesMarketplaceAndSkillLinks pins the C decision:
// `felt uninstall` used to remove the Claude plugin and leave cailmdaley-felt
// registered in ~/.claude/settings.json, so it was the inverse of `felt setup
// codex` (which has always removed its marketplace) but not of `felt setup
// claude`. The marketplace declares exactly one plugin, so nothing else is
// hanging off it — and the skills `felt setup skills` linked out of its clone
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
