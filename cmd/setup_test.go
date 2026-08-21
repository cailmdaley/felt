package cmd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestPiPackageSource pins the pi-side translation: pi's git shorthand needs
// the full github.com host, and a pinned Claude ref (`#v<tag>`) becomes pi's
// `@v<tag>`. Local paths pass through — pi installs a directory in place.
func TestPiPackageSource(t *testing.T) {
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
	const noRef = "git:github.com/cailmdaley/felt"

	t.Run("absent settings → empty", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		if got := piFeltPackageSource(); got != "" {
			t.Errorf("piFeltPackageSource() = %q, want \"\"", got)
		}
	})

	t.Run("no felt package → empty", func(t *testing.T) {
		home := t.TempDir()
		writePiSettings(t, home, []string{"npm:pi-subagents", "/home/dev/unrelated"})
		t.Setenv("HOME", home)
		if got := piFeltPackageSource(); got != "" {
			t.Errorf("piFeltPackageSource() = %q, want \"\"", got)
		}
	})

	for _, tc := range []struct{ name, entry, want string }{
		{"git bare", noRef, noRef},
		{"git tagged", noRef + "@v1.0.14", noRef + "@v1.0.14"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			writePiSettings(t, home, []string{"npm:pi-subagents", tc.entry})
			t.Setenv("HOME", home)
			if got := piFeltPackageSource(); got != tc.want {
				t.Errorf("piFeltPackageSource() = %q, want %q", got, tc.want)
			}
		})
	}

	t.Run("local checkout by package name", func(t *testing.T) {
		home := t.TempDir()
		checkout := filepath.Join(home, "dev", "felt")
		scaffoldFeltCheckout(t, checkout)
		writePiSettings(t, home, []string{checkout})
		t.Setenv("HOME", home)
		if got := piFeltPackageSource(); got != checkout {
			t.Errorf("piFeltPackageSource() = %q, want %q", got, checkout)
		}
	})

	t.Run("home-relative local entry", func(t *testing.T) {
		home := t.TempDir()
		scaffoldFeltCheckout(t, filepath.Join(home, "dev", "felt"))
		writePiSettings(t, home, []string{"dev/felt"})
		t.Setenv("HOME", home)
		if got := piFeltPackageSource(); got != "dev/felt" {
			t.Errorf("piFeltPackageSource() = %q, want %q", got, "dev/felt")
		}
	})

	t.Run("local dir without felt package.json → empty", func(t *testing.T) {
		home := t.TempDir()
		other := filepath.Join(home, "dev", "other")
		scaffoldFeltCheckout(t, other)
		if err := os.WriteFile(filepath.Join(other, "package.json"), []byte(`{"name":"other"}`), 0o644); err != nil {
			t.Fatal(err)
		}
		writePiSettings(t, home, []string{other})
		t.Setenv("HOME", home)
		if got := piFeltPackageSource(); got != "" {
			t.Errorf("piFeltPackageSource() = %q, want \"\"", got)
		}
	})

	t.Run("malformed settings → empty", func(t *testing.T) {
		home := t.TempDir()
		if err := os.MkdirAll(filepath.Join(home, ".pi", "agent"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(home, ".pi", "agent", "settings.json"), []byte("{not json"), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Setenv("HOME", home)
		if got := piFeltPackageSource(); got != "" {
			t.Errorf("piFeltPackageSource() = %q, want \"\"", got)
		}
	})

	t.Run("tilde entry expanded against home", func(t *testing.T) {
		home := t.TempDir()
		scaffoldFeltCheckout(t, filepath.Join(home, "dev", "felt"))
		writePiSettings(t, home, []string{"~/dev/felt"})
		t.Setenv("HOME", home)
		if got := piFeltPackageSource(); got != "~/dev/felt" {
			t.Errorf("piFeltPackageSource() = %q, want %q", got, "~/dev/felt")
		}
	})
}

// TestInstallPiPackageViaCLI_SourceSwap pins the remove-before-install
// orchestration end to end: flipping samePiSourceLocation's negation would
// otherwise pass every pure-comparator test while duplicating felt in pi's
// settings. fakePiOnPath is the pi-side mirror of fakeClaudeOnPath.
func TestInstallPiPackageViaCLI_SourceSwap(t *testing.T) {
	const gitSpec = "git:github.com/cailmdaley/felt"

	// fakePiOnPath puts a stub `pi` at the front of PATH for the duration of
	// the test, logging every invocation — the pi-side mirror of
	// fakeClaudeOnPath. Returns a func reading the log.
	fakePiOnPath := func(t *testing.T) func() string {
		dir := t.TempDir()
		log := filepath.Join(dir, "calls.log")
		script := "#!/bin/sh\necho \"$@\" >> " + log + "\nexit 0\n"
		if err := os.WriteFile(filepath.Join(dir, "pi"), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
		t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
		return func() string {
			b, _ := os.ReadFile(log)
			return string(b)
		}
	}

	t.Run("orchestrator swaps a differing source before install", func(t *testing.T) {
		// Pins installPiPackageViaCLI's remove-before-install flow end to end:
		// flipping samePiSourceLocation's negation would otherwise pass every
		// pure-comparator test while duplicating felt in pi's settings.
		home := t.TempDir()
		checkout := filepath.Join(home, "dev", "felt")
		scaffoldFeltCheckout(t, checkout)
		writePiSettings(t, home, []string{"npm:pi-subagents", checkout})
		t.Setenv("HOME", home)
		calls := fakePiOnPath(t)

		if err := installPiPackageViaCLI(gitSpec); err != nil {
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
		home := t.TempDir()
		writePiSettings(t, home, []string{gitSpec})
		t.Setenv("HOME", home)
		calls := fakePiOnPath(t)

		if err := installPiPackageViaCLI(gitSpec + "@v1.2.3"); err != nil {
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
// marketplace before it installs anything. Returns a func reading the log.
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
// setup that could not recover from a registered-but-not-installed state — a
// marketplace add that succeeded followed by an install that didn't, or a
// hand-run `claude plugin marketplace add`. Choosing install-vs-update by
// marketplace registration sent the next setup to `claude plugin update`,
// which hard-fails on a plugin that isn't installed. The op must follow
// whether the PLUGIN is installed.
func TestInstallPluginViaCLI_OpFollowsPluginNotMarketplace(t *testing.T) {
	pluginRef := "felt@" + marketplaceName

	t.Run("plugin absent → install", func(t *testing.T) {
		// A registered marketplace with no felt plugin: the state an install
		// that failed after `marketplace add` leaves behind.
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

// TestUninstallPluginRemovesMarketplaceAndSkillLinks pins the C decision:
// `felt uninstall` used to remove the Claude plugin and leave cailmdaley-felt
// registered in ~/.claude/settings.json, so it was the inverse of `felt setup
// codex` (which has always removed its marketplace) but not of `felt setup
// claude`. The marketplace declares exactly one plugin, so nothing else is
// hanging off it — and the skills `felt setup skills` linked out of its clone
// have to be unlinked first, or removing the clone leaves dangling symlinks.
func TestUninstallPluginRemovesMarketplaceAndSkillLinks(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	calls := fakeClaudeOnPath(t, `[{"id":"felt@`+marketplaceName+`"}]`)

	// A skill linked from the marketplace clone (goes), one linked from a
	// local checkout (stays — its target survives uninstall), and a real
	// directory (never ours to touch).
	cloneSkills := filepath.Join(home, ".claude", "plugins", "marketplaces", marketplaceName, "claude-plugin", "skills", "felt")
	checkoutSkill := filepath.Join(home, "src", "felt", "claude-plugin", "skills", "shuttle")
	skillsDir := filepath.Join(home, ".claude", "skills")
	for _, d := range []string{cloneSkills, checkoutSkill, skillsDir, filepath.Join(skillsDir, "unrelated")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(cloneSkills, filepath.Join(skillsDir, "felt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(checkoutSkill, filepath.Join(skillsDir, "shuttle")); err != nil {
		t.Fatal(err)
	}

	if err := uninstallPlugin(); err != nil {
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
	if _, err := os.Lstat(filepath.Join(skillsDir, "shuttle")); err != nil {
		t.Errorf("skill linked from a local checkout was removed: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(skillsDir, "unrelated")); err != nil {
		t.Errorf("unrelated skill directory was removed: %v", err)
	}
}
