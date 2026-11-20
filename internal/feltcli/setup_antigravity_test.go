package feltcli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv"
	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
)

// `felt setup antigravity` writes a native agy plugin agy loads: plugin.json
// and hooks.json at its root, the shim the hooks run, and the felt and
// shuttle skills; it replaces only plugins/felt/, and --uninstall removes it.
func TestSetupAntigravityInstallsTheNativePlugin(t *testing.T) {
	t.Parallel()
	env, _ := testEnv(t)
	sysenvtest.OnlyPath(env)
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
	sysenvtest.OnlyPath(env)
	source := copyPluginSource(t)
	if err := os.Remove(filepath.Join(source, "claude-plugin", "hooks", "agy.sh")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := executeIn(t, env, t.TempDir(), "setup", "antigravity", "--source", source); err == nil || !strings.Contains(err.Error(), "agy.sh") {
		t.Fatalf("setup from a source without the shim: %v", err)
	}
	if _, err := os.Stat(filepath.Join(homeOf(t, env), ".gemini", "config", "plugins", "felt")); !os.IsNotExist(err) {
		t.Fatalf("a plugin was installed: %v", err)
	}
}

// copyPluginSource is a writable copy of the checkout's plugin source: the
// marketplace, the shared plugin and the pi package.
func copyPluginSource(t *testing.T) string {
	t.Helper()
	source := t.TempDir()
	for _, name := range append([]string{".claude-plugin", "claude-plugin"}, piPackageFiles...) {
		if err := copyTree(filepath.Join(repoRoot(t), name), filepath.Join(source, name)); err != nil {
			t.Fatal(err)
		}
	}
	return source
}

// fakePi is a pi whose `pi list` reports what `pi install` last installed,
// in pi's layout: the source, then the directory it resolves to, starting
// from source at path. It returns a reader of the calls pi saw.
func fakePi(t *testing.T, env *sysenv.Env, source, path string) func() string {
	t.Helper()
	state := filepath.Join(t.TempDir(), "pi-packages")
	if source != "" {
		if err := os.WriteFile(state, []byte("  "+source+"\n    "+path+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	env.Set("FAKE_PI_STATE", state)
	return fakeCallLog(t, env, "pi", `case "$1" in
  list) echo "User packages:"; cat "$FAKE_PI_STATE" 2>/dev/null ;;
  install) printf '  %s\n    %s\n' "$2" "$2" > "$FAKE_PI_STATE" ;;
  remove) : > "$FAKE_PI_STATE" ;;
esac
`)
}

// scaffoldFeltCheckout makes a directory holding a package.json named felt,
// what pi sees at the path of a felt package.
func scaffoldFeltCheckout(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"name":"felt","private":true}`), 0o644); err != nil {
		t.Fatal(err)
	}
}

// Every harness carrying felt follows a promotion, whichever harness it was
// set up for: agy's plugin moves to the new generation when pi is set up
// from it, and pi loads the generation directory itself. The receipt then
// verifies both harnesses against that generation.
func TestPromotionMovesEveryHarnessCarryingFelt(t *testing.T) {
	t.Parallel()
	env, _ := testEnv(t)
	sysenvtest.OnlyPath(env)
	home := homeOf(t, env)
	clone := filepath.Join(t.TempDir(), "felt")
	scaffoldFeltCheckout(t, clone)
	calls := fakePi(t, env, "git:github.com/"+marketplaceRepo, clone)

	if _, stderr, err := executeIn(t, env, t.TempDir(), "setup", "antigravity", "--source", copyPluginSource(t)); err != nil {
		t.Fatalf("setup antigravity: %v %s", err, stderr)
	}
	second := copyPluginSource(t)
	skill := filepath.Join("skills", "felt", "SKILL.md")
	if err := os.WriteFile(filepath.Join(second, "claude-plugin", skill), []byte("second generation\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, stderr, err := executeIn(t, env, t.TempDir(), "setup", "pi", "--source", second); err != nil {
		t.Fatalf("setup pi: %v %s", err, stderr)
	}

	agy := filepath.Join(home, ".gemini", "config", "plugins", "felt")
	current := filepath.Join(home, ".felt", pluginRuntimeDirName, pluginCurrentName)
	if got, _ := os.ReadFile(filepath.Join(agy, skill)); string(got) != "second generation\n" {
		t.Fatalf("agy's plugin stayed on the first generation: %q", got)
	}
	log := calls()
	remove, install := strings.Index(log, "remove git:github.com/"+marketplaceRepo), strings.Index(log, "install "+current)
	if remove < 0 || install < remove {
		t.Fatalf("pi was not moved from its GitHub package to the generation:\n%s", log)
	}
	for _, path := range []string{"package.json", "extensions/pi/index.ts", "claude-plugin/skills/felt/SKILL.md"} {
		if _, err := os.Stat(filepath.Join(current, path)); err != nil {
			t.Fatalf("the generation is not a pi package: %v", err)
		}
	}

	if _, stderr, err := executeIn(t, env, t.TempDir(), "setup", "pi", "--source", second); err != nil {
		t.Fatalf("setup pi again: %v %s", err, stderr)
	}
	if again := strings.TrimPrefix(calls(), log); strings.Contains(again, "install") || strings.Contains(again, "remove") {
		t.Fatalf("pi already on the generation was installed again:\n%s", again)
	}

	r := testApp(t, env).collectRuntimeReceipt()
	var harnesses []string
	for _, h := range r.Harnesses {
		harnesses = append(harnesses, h.Harness)
	}
	if strings.Join(harnesses, " ") != "pi antigravity" {
		t.Fatalf("receipt harnesses = %v, want pi and antigravity", harnesses)
	}
	if r.Hooks.Status != receiptHealthy {
		t.Fatalf("hooks %s: %s", r.Hooks.Status, r.Hooks.Repair)
	}
	if len(r.Generation.Harnesses) != 2 {
		t.Fatalf("generation checks = %+v", r.Generation.Harnesses)
	}
	for _, check := range r.Generation.Harnesses {
		if check.Status != receiptHealthy {
			t.Fatalf("%s generation %s: %s", check.Harness, check.Status, check.Repair)
		}
	}

	if err := os.WriteFile(filepath.Join(agy, skill), []byte("edited\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r = testApp(t, env).collectRuntimeReceipt()
	if r.Generation.Status != receiptMismatch || !strings.Contains(r.Generation.Repair, "felt setup antigravity") {
		t.Fatalf("an edited agy plugin passed the receipt: %s %s", r.Generation.Status, r.Generation.Repair)
	}
}

// agy's own plugin list decides whether felt is enabled there.
func TestReceiptReadsAgyPluginList(t *testing.T) {
	t.Parallel()
	for name, c := range map[string]struct {
		list    string
		fails   bool
		want    receiptInspection
		bundles int
	}{
		"enabled":  {list: `[{"name":"felt","enabled":true,"path":"PLUGIN"}]`, want: inspectionConfirmed, bundles: 1},
		"disabled": {list: `[{"name":"felt","enabled":false,"path":"PLUGIN"}]`},
		"absent":   {list: `[{"name":"loom","enabled":true,"path":"/elsewhere"}]`},
		"failing":  {fails: true, want: inspectionUnknown, bundles: 1},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			env, _ := testEnv(t)
			sysenvtest.OnlyPath(env)
			a := testApp(t, env)
			dir, err := a.antigravityPluginDir()
			if err != nil {
				t.Fatal(err)
			}
			env.Set("FAKE_AGY_LIST", strings.ReplaceAll(c.list, "PLUGIN", dir))
			status := "0"
			if c.fails {
				status = "1"
			}
			fakeCommand(t, env, "agy", "[ \"$AGY_CLI_DISABLE_AUTO_UPDATE\" = true ] || exit 3\nprintf '%s' \"$FAKE_AGY_LIST\"\nexit "+status+"\n")
			bundles := a.collectAntigravityBundle()
			if len(bundles) != c.bundles {
				t.Fatalf("bundles = %+v", bundles)
			}
			if c.bundles == 1 && bundles[0].Inspection != c.want {
				t.Fatalf("inspection = %s, want %s", bundles[0].Inspection, c.want)
			}
		})
	}
}
