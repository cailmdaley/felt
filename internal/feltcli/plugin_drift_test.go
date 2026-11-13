package feltcli

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestPluginDriftAppearsInSessionAndSync(t *testing.T) {
	t.Parallel()
	for _, harness := range []string{"claude", "codex"} {
		t.Run(harness, func(t *testing.T) {
			dir, _ := newStore(t)
			env, _ := testEnv(t)
			a := testApp(t, env)
			runtimeDir, _ := a.pluginRuntimeDir()
			current := filepath.Join(runtimeDir, pluginCurrentName)
			if err := os.MkdirAll(current, 0755); err != nil {
				t.Fatal(err)
			}
			marker := pluginGenerationIdentity{Schema: 1, SourceKind: "local", Source: "/fixture", PluginVersion: "2.0.0", FeltBuild: "2.0.0", PayloadSHA256: "fixture", Harnesses: []string{harness}}
			if harness == "codex" {
				marker.CodexBundles = codexBundleNames
			}
			if err := writePluginGeneration(current, marker); err != nil {
				t.Fatal(err)
			}
			note := harness + ": felt plugin entries are missing; run `felt setup " + harness + "` to repair."
			out, stderr, err := executeIn(t, env, dir, "session")
			want := "# Felt Workflow Context\n\n" + sessionDirective + "\n\n" + sessionNoTrackedNote + "\n\n## Attention\n\n" + note + "\n"
			if err != nil || stderr != "" || out != want {
				t.Fatalf("session err=%v stderr=%q\ngot %q\nwant %q", err, stderr, out, want)
			}
			// A non-git fixture lets the sync fail without fetching any repository;
			// the drift warning must still be printed on the ordinary command path.
			_, stderr, _ = executeIn(t, env, dir, "sync")
			if !strings.Contains(stderr, note) {
				t.Fatalf("sync didn't report drift: %s", stderr)
			}
			var cfgPath, config string
			if harness == "claude" {
				cfgPath, _ = a.homePath(".claude", "settings.json")
				config = `{"enabledPlugins":{"felt@cailmdaley-felt":true},"extraKnownMarketplaces":{"cailmdaley-felt":{"source":{"source":"directory","path":"/fixture"}}}}`
			} else {
				cfgPath, _ = a.homePath(".codex", "config.toml")
				config = "[plugins.\"felt@cailmdaley-felt\"]\nenabled = true\n[plugins.\"felt-skills@cailmdaley-felt\"]\nenabled = true\n[marketplaces.cailmdaley-felt]\nsource = '/fixture'\n"
			}
			if err := os.MkdirAll(filepath.Dir(cfgPath), 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(cfgPath, []byte(config), 0644); err != nil {
				t.Fatal(err)
			}
			if got := a.pluginDriftNotes(); len(got) != 0 {
				t.Fatalf("healthy config: %v", got)
			}
			if err := os.WriteFile(cfgPath, []byte(strings.ReplaceAll(config, "true", "false")), 0644); err != nil {
				t.Fatal(err)
			}
			if got := a.pluginDriftNotes(); len(got) != 0 {
				t.Fatalf("explicitly disabled plugin is not missing: %v", got)
			}
			// Losing either registration is enough to stop the plugin loading.
			for _, damaged := range []string{strings.ReplaceAll(config, "felt@cailmdaley-felt", "other@cailmdaley-felt"), func() string {
				if harness == "claude" {
					return `{"enabledPlugins":{"felt@cailmdaley-felt":true}}`
				}
				return "[plugins.\"felt@cailmdaley-felt\"]\nenabled = true\n[plugins.\"felt-skills@cailmdaley-felt\"]\nenabled = true\n"
			}()} {
				if err := os.WriteFile(cfgPath, []byte(damaged), 0644); err != nil {
					t.Fatal(err)
				}
				if got := a.pluginDriftNotes(); !reflect.DeepEqual(got, []string{note}) {
					t.Fatalf("missing registration: %v", got)
				}
			}
			if harness == "claude" {
				// Claude's native marketplace add records registration outside
				// settings.json; extraKnownMarketplaces is another valid source.
				knownPath, _ := a.homePath(".claude", "plugins", "known_marketplaces.json")
				if err := os.MkdirAll(filepath.Dir(knownPath), 0755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(knownPath, []byte(`{"cailmdaley-felt":{"source":{"source":"directory","path":"/fixture"}}}`), 0644); err != nil {
					t.Fatal(err)
				}
				if got := a.pluginDriftNotes(); len(got) != 0 {
					t.Fatalf("native marketplace registration: %v", got)
				}
				if err := os.Remove(knownPath); err != nil {
					t.Fatal(err)
				}
			}
			if err := setPluginHarness(current, harness, false); err != nil {
				t.Fatal(err)
			}
			if got := a.pluginDriftNotes(); len(got) != 0 {
				t.Fatalf("uninstalled harness: %v", got)
			}
		})
	}
}

func TestCodexDriftChecksOnlyInstalledBundles(t *testing.T) {
	t.Parallel()
	env, _ := testEnv(t)
	a := testApp(t, env)
	runtimeDir, _ := a.pluginRuntimeDir()
	current := filepath.Join(runtimeDir, pluginCurrentName)
	if err := os.MkdirAll(current, 0755); err != nil {
		t.Fatal(err)
	}
	marker := pluginGenerationIdentity{Schema: 1, SourceKind: "local", Source: "/fixture", PluginVersion: "2.0.0", FeltBuild: "2.0.0", PayloadSHA256: "fixture"}
	if err := writePluginGeneration(current, marker); err != nil {
		t.Fatal(err)
	}
	if err := setPluginHarness(current, "codex", true, []string{"felt"}); err != nil {
		t.Fatal(err)
	}
	cfgPath, _ := a.homePath(".codex", "config.toml")
	if err := os.MkdirAll(filepath.Dir(cfgPath), 0755); err != nil {
		t.Fatal(err)
	}
	config := "[plugins.\"felt@cailmdaley-felt\"]\nenabled = false\n[marketplaces.cailmdaley-felt]\nsource = '/fixture'\n"
	if err := os.WriteFile(cfgPath, []byte(config), 0644); err != nil {
		t.Fatal(err)
	}
	if got := a.pluginDriftNotes(); len(got) != 0 {
		t.Fatalf("uninstalled skills bundle required: %v", got)
	}
	if err := setPluginHarness(current, "codex", true, []string{"felt-skills"}); err != nil {
		t.Fatal(err)
	}
	if got := a.pluginDriftNotes(); len(got) != 1 {
		t.Fatalf("installed skills bundle's disappearance was missed: %v", got)
	}
	identity, err := readPluginGeneration(filepath.Join(current, "claude-plugin"))
	if err != nil || strings.Join(identity.CodexBundles, ",") != "felt,felt-skills" {
		t.Fatalf("recorded bundles: %+v, %v", identity.CodexBundles, err)
	}
}

func TestPluginHarnessOwnershipRecordsAndDeduplicates(t *testing.T) {
	t.Parallel()
	env, _ := testEnv(t)
	a := testApp(t, env)
	runtimeDir, _ := a.pluginRuntimeDir()
	current := filepath.Join(runtimeDir, pluginCurrentName)
	if err := os.MkdirAll(current, 0755); err != nil {
		t.Fatal(err)
	}
	marker := pluginGenerationIdentity{Schema: 1, SourceKind: "local", Source: "/fixture", PluginVersion: "2.0.0", FeltBuild: "2.0.0", PayloadSHA256: "fixture"}
	if err := writePluginGeneration(current, marker); err != nil {
		t.Fatal(err)
	}
	for _, h := range []string{"claude", "codex", "claude"} {
		if err := setPluginHarness(current, h, true); err != nil {
			t.Fatal(err)
		}
	}
	got, err := readPluginGeneration(filepath.Join(current, "claude-plugin"))
	if err != nil || !reflect.DeepEqual(got.Harnesses, []string{"claude", "codex"}) {
		t.Fatalf("%+v %v", got, err)
	}
}
