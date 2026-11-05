package feltcli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The source payload has two classes. The marketplace and source
// manifests are hook packaging inputs; Codex's generated adapter manifests
// deliberately do not inherit their release versions.
func codexPluginFileClass(path string) string {
	switch path {
	case ".claude-plugin/marketplace.json", "claude-plugin/.claude-plugin/plugin.json", "claude-plugin/.codex-plugin/plugin.json":
		return "hook-bundle"
	case "claude-plugin/hooks/hooks.json", "claude-plugin/hooks/event.sh", "claude-plugin/hooks/felt-bin.sh", "claude-plugin/hooks/handoff.sh", "claude-plugin/hooks/remind.sh", "claude-plugin/hooks/session.sh", "claude-plugin/hooks/shuttle-bin.sh", "claude-plugin/hooks/touch.sh":
		return "hook-bundle"
	case "claude-plugin/hooks/handoff.mjs", "claude-plugin/hooks/lib/handoff.mjs":
		return "pi-only"
	}
	if strings.HasPrefix(path, "claude-plugin/skills/") {
		return "skills-bundle"
	}
	return ""
}

func TestCodexPluginPayloadClassificationGate(t *testing.T) {
	t.Parallel()
	root := repoRoot(t)
	// Check all source files, including every tracked file, without requiring
	// Git metadata in release archives or Linux container mounts.
	for _, directory := range []string{"claude-plugin", ".claude-plugin"} {
		if err := filepath.Walk(filepath.Join(root, directory), func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return err
			}
			if info.IsDir() {
				return nil
			}
			relative, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			if codexPluginFileClass(filepath.ToSlash(relative)) == "" {
				t.Errorf("unclassified plugin file %s: assign it to the hook-bundle or skills-bundle before shipping", relative)
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	candidate := t.TempDir()
	for _, name := range []string{".claude-plugin", "claude-plugin"} {
		if err := copyTree(filepath.Join(root, name), filepath.Join(candidate, name)); err != nil {
			t.Fatal(err)
		}
	}
	if err := materializeCodexBundles(candidate); err != nil {
		t.Fatal(err)
	}
	for _, name := range codexBundleNames {
		bundle := codexBundleSource(candidate, name)
		if _, err := pluginPayloadDigest(bundle); err != nil {
			t.Fatal(err)
		}
		if err := filepath.Walk(bundle, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return err
			}
			if info.IsDir() || filepath.Ext(path) != ".json" {
				return nil
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			for _, key := range []string{"resolved_commit", "source_kind", "requested_ref", "felt_build", "checkout_path", "payload_sha256", "codex_payload_sha256"} {
				if strings.Contains(string(data), `"`+key+`"`) {
					t.Errorf("release metadata %q inside hashed %s root: %s", key, name, path)
				}
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestCodexHookAllowlistRejectsUnclassifiedReleaseFiles(t *testing.T) {
	for _, path := range []string{"claude-plugin/hooks/BUILD_COMMIT", "claude-plugin/hooks/release.json", "claude-plugin/hooks/new.sh"} {
		if class := codexPluginFileClass(path); class != "" {
			t.Errorf("unreviewed source %s automatically classified as %s", path, class)
		}
	}
}

func TestCodexGeneratedHookTreeMatchesAllowlist(t *testing.T) {
	t.Parallel()
	candidate := t.TempDir()
	if err := copyTree(filepath.Join(repoRoot(t), "claude-plugin"), filepath.Join(candidate, "claude-plugin")); err != nil {
		t.Fatal(err)
	}
	if err := materializeCodexBundles(candidate); err != nil {
		t.Fatal(err)
	}
	expected := map[string]bool{
		".codex-plugin": true, ".codex-plugin/plugin.json": true, "hooks": true,
		"hooks/hooks.json": true, "hooks/event.sh": true, "hooks/felt-bin.sh": true,
		"hooks/handoff.sh": true, "hooks/remind.sh": true, "hooks/session.sh": true,
		"hooks/shuttle-bin.sh": true, "hooks/touch.sh": true,
	}
	root := codexBundleSource(candidate, "felt")
	if err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if path == root {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if !expected[rel] {
			t.Errorf("unexpected entry in hashed hook root: %s", rel)
		}
		delete(expected, rel)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(expected) > 0 {
		t.Fatalf("hook root missing allowlisted entries: %v", expected)
	}
}

func TestCodexBundleProjectionDoesNotInheritReleaseVersion(t *testing.T) {
	t.Parallel()
	candidate := t.TempDir()
	if err := copyTree(filepath.Join(repoRoot(t), "claude-plugin"), filepath.Join(candidate, "claude-plugin")); err != nil {
		t.Fatal(err)
	}
	if err := materializeCodexBundles(candidate); err != nil {
		t.Fatal(err)
	}
	before := map[string]string{}
	for _, name := range codexBundleNames {
		digest, err := pluginPayloadDigest(codexBundleSource(candidate, name))
		if err != nil {
			t.Fatal(err)
		}
		before[name] = digest
	}
	for _, harness := range []string{".claude-plugin", ".codex-plugin"} {
		path := filepath.Join(candidate, "claude-plugin", harness, "plugin.json")
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var doc map[string]any
		if err := json.Unmarshal(data, &doc); err != nil {
			t.Fatal(err)
		}
		doc["version"] = "99.0.0"
		if err := writeCodexBundleJSON(path, doc); err != nil {
			t.Fatal(err)
		}
	}
	if err := materializeCodexBundles(candidate); err != nil {
		t.Fatal(err)
	}
	for _, name := range codexBundleNames {
		digest, err := pluginPayloadDigest(codexBundleSource(candidate, name))
		if err != nil || digest != before[name] {
			t.Fatalf("release manifest changed %s bytes: %s != %s (%v)", name, digest, before[name], err)
		}
	}
}

func TestCodexReceiptVerifiesBothBundles(t *testing.T) {
	t.Parallel()
	f := newRemoteSetupFixture(t, "codex")
	if err := f.a.installCodexPluginViaCLI(f.remote); err != nil {
		t.Fatal(err)
	}
	bundles := f.a.collectCodexBundle()
	if len(bundles) != 2 {
		t.Fatalf("bundles: %+v", bundles)
	}
	for _, bundle := range bundles {
		if bundle.Status != receiptHealthy {
			t.Fatalf("unhealthy split bundle: %+v", bundle)
		}
	}
	skills, err := f.a.verifiedCodexBundleRoot("felt-skills")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(skills, "skills", "felt", "SKILL.md")
	if err := os.WriteFile(path, []byte("tampered"), 0644); err != nil {
		t.Fatal(err)
	}
	bundles = f.a.collectCodexBundle()
	if bundles[0].Status != receiptHealthy || bundles[1].Name != "felt-skills" || bundles[1].Status != receiptMismatch {
		t.Fatalf("tampered skills not independently diagnosed: %+v", bundles)
	}
	if err := os.Remove(filepath.Join(f.stateDir, "installed-felt-skills")); err != nil {
		t.Fatal(err)
	}
	bundles = f.a.collectCodexBundle()
	if len(bundles) != 2 || bundles[1].Status != receiptMissing {
		t.Fatalf("missing skills not diagnosed: %+v", bundles)
	}
}

func TestCodexDisabledBundleDoesNotOptHarnessIntoDeploy(t *testing.T) {
	t.Parallel()
	f := newRemoteSetupFixture(t, "codex")
	if err := f.a.installCodexPluginViaCLI(f.remote); err != nil {
		t.Fatal(err)
	}
	bundles, found := f.a.codexBundlesFromList([]receiptInstalledPlugin{{PluginID: codexPluginRef, Enabled: false}})
	if !found || len(bundles) != 0 {
		t.Fatalf("disabled Codex synthesized deployment work: found=%v bundles=%+v", found, bundles)
	}
	root := filepath.Join(f.home, ".felt", pluginRuntimeDirName, pluginCurrentName, "claude-plugin")
	claude := f.a.bundleFromManifest("claude", filepath.Join(root, ".claude-plugin", "plugin.json"), root)
	bundles = append(bundles, claude)
	hooks := f.a.collectHookReceipt(bundles)
	generation := f.a.collectGenerationReceipt(bundles, ReceiptComponent{})
	status, _ := combineReceiptStatus(receiptHealthy, bundles, hooks.Status, generation.Status)
	if status != receiptHealthy {
		t.Fatalf("disabled Codex broke healthy Claude: bundles=%+v hooks=%+v generation=%+v", bundles, hooks, generation)
	}
}

func TestCodexProjectionIgnoresPiOnlyHookSources(t *testing.T) {
	t.Parallel()
	candidate := t.TempDir()
	if err := copyTree(filepath.Join(repoRoot(t), "claude-plugin"), filepath.Join(candidate, "claude-plugin")); err != nil {
		t.Fatal(err)
	}
	if err := materializeCodexBundles(candidate); err != nil {
		t.Fatal(err)
	}
	before, err := pluginPayloadDigest(codexBundleSource(candidate, "felt"))
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"handoff.mjs", "lib/handoff.mjs"} {
		path := filepath.Join(candidate, "claude-plugin", "hooks", name)
		f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
		if err != nil {
			t.Fatal(err)
		}
		_, err = f.WriteString("\n// Pi-only change\n")
		f.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := materializeCodexBundles(candidate); err != nil {
		t.Fatal(err)
	}
	after, err := pluginPayloadDigest(codexBundleSource(candidate, "felt"))
	if err != nil || before != after {
		t.Fatalf("Pi-only change invalidated Codex hooks: %s -> %s (%v)", before, after, err)
	}
	if !hookFilesCompatible(codexBundleSource(candidate, "felt")) {
		t.Fatal("minimal hook projection is incomplete")
	}
}

func TestCodexSetupDocsNameSkillsAndRollbackCleanup(t *testing.T) {
	t.Parallel()
	for _, path := range []string{"docs/agents.md", "docs/dev/releasing.md"} {
		data, err := os.ReadFile(filepath.Join(repoRoot(t), path))
		if err != nil {
			t.Fatal(err)
		}
		for _, required := range []string{"felt-skills:felt", "felt-skills:shuttle", "codex plugin remove felt-skills@cailmdaley-felt"} {
			if !strings.Contains(string(data), required) {
				t.Errorf("%s omits %s", path, required)
			}
		}
	}
}

func TestCodexRollbackVerifiesSkillsCache(t *testing.T) {
	t.Parallel()
	f := newRemoteSetupFixture(t, "codex")
	if err := f.a.installCodexPluginViaCLI(f.remote); err != nil {
		t.Fatal(err)
	}
	state, err := f.a.captureCodexInstallation()
	if err != nil {
		t.Fatal(err)
	}
	if !state.Installed || !state.SkillsInstalled {
		t.Fatalf("incomplete native capture: %+v", state)
	}
	f.env.Set("FAKE_NATIVE_TAMPER", "alter-skills")
	err = f.a.restoreCodexInstallation(state)
	if err == nil || !strings.Contains(err.Error(), "verifying restored Codex felt-skills") {
		t.Fatalf("unverified skills rollback was accepted: %v", err)
	}
}

func TestPluginPayloadRejectsReleaseMetadata(t *testing.T) {
	t.Parallel()
	for _, name := range []string{pluginGenerationMarkerName, ".felt-generation-orphan", "..felt-generation.json-123.tmp"} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			if err := os.WriteFile(filepath.Join(root, name), []byte("{}"), 0644); err != nil {
				t.Fatal(err)
			}
			if _, err := pluginPayloadDigest(root); err == nil {
				t.Fatal("release metadata accepted inside plugin root")
			}
		})
	}
}
