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
	}
	if strings.HasPrefix(path, "claude-plugin/hooks/") {
		return "hook-bundle"
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
 for _,directory := range []string{"claude-plugin",".claude-plugin"} {
  if err := filepath.Walk(filepath.Join(root,directory),func(path string,info os.FileInfo,err error) error {
   if err != nil { return err }; if info.IsDir() { return nil }
   relative,err := filepath.Rel(root,path); if err != nil { return err }
   if codexPluginFileClass(filepath.ToSlash(relative)) == "" { t.Errorf("unclassified plugin file %s: assign it to the hook-bundle or skills-bundle before shipping",relative) }
   return nil
  }); err != nil { t.Fatal(err) }
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
