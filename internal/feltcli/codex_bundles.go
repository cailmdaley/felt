package feltcli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Bundle versions describe the adapter format, not the Felt release. Payload
// digests decide whether setup must refresh either native cache.
const codexBundleVersion = "1.0.0"
const codexSkillsPluginRef = "felt-skills@" + marketplaceName

var codexBundleNames = []string{"felt", "felt-skills"}

func codexBundleSource(current, name string) string {
	if name == "felt" {
		return filepath.Join(current, "codex-hooks")
	}
	return filepath.Join(current, "codex-skills")
}

// materializeCodexBundles projects the shared source without copying release
// manifests or provenance into either of Codex's content-approval boundaries.
func materializeCodexBundles(current string) error {
	for _, name := range codexBundleNames {
		root := codexBundleSource(current, name)
		if err := os.RemoveAll(root); err != nil {
			return err
		}
		manifest := pluginManifest{Name: name, Version: codexBundleVersion}
		directory := "skills"
		if name == "felt" {
			directory = "hooks"
			manifest.Hooks = "./hooks/hooks.json"
		} else {
			manifest.Skills = "./skills"
		}
		if err := copyTree(filepath.Join(current, "claude-plugin", directory), filepath.Join(root, directory)); err != nil {
			return err
		}
		if err := writeCodexBundleJSON(filepath.Join(root, ".codex-plugin", "plugin.json"), manifest); err != nil {
			return err
		}
	}
	// Codex prefers .agents over the Claude marketplace. Claude's native
	// packaging and source registration remain independent of this projection.
	market := map[string]any{"name": marketplaceName, "owner": map[string]string{"name": "felt"}, "plugins": []map[string]string{
		{"name": "felt", "source": "./codex-hooks"},
		{"name": "felt-skills", "source": "./codex-skills"},
	}}
	return writeCodexBundleJSON(filepath.Join(current, ".agents", "plugins", "marketplace.json"), market)
}

func (a *app) codexBundlesFromList(plugins []receiptInstalledPlugin) ([]ReceiptBundle, bool) {
	var bundles []ReceiptBundle
	found := false
	enabledFound := false
	seen := map[string]bool{}
	for _, name := range codexBundleNames {
		for _, plugin := range plugins {
			if plugin.PluginID != name+"@"+marketplaceName && plugin.ID != name+"@"+marketplaceName && !(plugin.Name == name && plugin.MarketplaceName == marketplaceName) {
				continue
			}
			found = true
			seen[name] = true
			if !plugin.Enabled {
				continue
			}
			enabledFound = true
			root, err := a.verifiedCodexBundleRoot(name)
			if err != nil {
				bundles = append(bundles, ReceiptBundle{Name: name, Harness: "codex", Enabled: true, Inspection: inspectionConfirmed, Evidence: "codex plugin list and cache", Status: receiptMismatch, Repair: fmt.Sprintf("%v; run `felt setup codex`", err)})
				continue
			}
			plugin.Source.Path = root
			bundles = append(bundles, a.bundleFromActivePlugin("codex", plugin))
		}
	}
	if enabledFound {
		runtimeDir, err := a.pluginRuntimeDir()
		if err == nil {
			expected, present, err := promotedGenerationForVerify(filepath.Join(runtimeDir, pluginCurrentName))
			if err == nil && present && expected.CodexPayloadSHA256 != nil {
				for _, name := range codexBundleNames {
					if !seen[name] {
						bundles = append(bundles, ReceiptBundle{Name: name, Harness: "codex", Enabled: true, Inspection: inspectionConfirmed, Status: receiptMissing, Repair: "run `felt setup codex` to install both Codex bundles"})
					}
				}
			}
		}
	}
	return bundles, found
}

func writeCodexBundleJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0644)
}

func codexBundleGeneration(expected pluginGenerationIdentity, name string) (pluginGenerationIdentity, error) {
	if expected.CodexPayloadSHA256 == nil && name == "felt" {
		return expected, nil
	}
	digest := expected.CodexPayloadSHA256[name]
	if digest == "" {
		return pluginGenerationIdentity{}, fmt.Errorf("promoted generation has no %s bundle digest; run `felt setup codex`", name)
	}
	expected.PayloadSHA256 = digest
	expected.PluginVersion = codexBundleVersion
	return expected, nil
}

func (a *app) verifiedCodexBundleRoot(name string) (string, error) {
	runtimeDir, err := a.pluginRuntimeDir()
	if err != nil {
		return "", err
	}
	expected, present, err := promotedGenerationForVerify(filepath.Join(runtimeDir, pluginCurrentName))
	if err != nil {
		return "", err
	}
	if !present {
		return "", fmt.Errorf("the promoted plugin has no %s provenance; run `felt setup codex`", pluginGenerationMarkerName)
	}
	expected, err = codexBundleGeneration(expected, name)
	if err != nil {
		return "", err
	}
	home, err := a.codexHome()
	if err != nil {
		return "", err
	}
	cache := filepath.Join(home, "plugins", "cache", marketplaceName, name, expected.PluginVersion)
	if err := verifyLoadedGeneration("codex "+name, expected, cache); err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(cache)
}
