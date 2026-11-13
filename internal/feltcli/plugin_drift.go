package feltcli

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
)

// setPluginHarness records setup ownership outside the plugin payload, in the
// promoted generation's existing marker. Uninstall removes that ownership.
func setPluginHarness(source, harness string, installed bool) error {
	pluginRoot := filepath.Join(source, "claude-plugin")
	identity, err := readPluginGeneration(pluginRoot)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	identity.Harnesses = slices.DeleteFunc(identity.Harnesses, func(h string) bool { return h == harness })
	if installed {
		identity.Harnesses = append(identity.Harnesses, harness)
	}
	slices.Sort(identity.Harnesses)
	return writePluginGeneration(source, identity)
}

func (a *app) forgetPluginHarness(harness string) error {
	runtimeDir, err := a.pluginRuntimeDir()
	if err != nil {
		return err
	}
	return setPluginHarness(filepath.Join(runtimeDir, pluginCurrentName), harness, false)
}

// pluginDriftNotes reads only the generation marker and native configuration.
// It does not inspect caches, hash payloads, or invoke a harness executable.
func (a *app) pluginDriftNotes() []string {
	runtimeDir, err := a.pluginRuntimeDir()
	if err != nil {
		return nil
	}
	identity, err := readPluginGeneration(filepath.Join(runtimeDir, pluginCurrentName, "claude-plugin"))
	if err != nil {
		return nil
	}
	var notes []string
	for _, harness := range identity.Harnesses {
		missing := false
		switch harness {
		case "claude":
			path, err := a.homePath(".claude", "settings.json")
			if err != nil {
				continue
			}
			settings, err := readJSONFile[receiptClaudeSettings](path)
			if err != nil && !os.IsNotExist(err) {
				continue
			}
			_, market := settings.ExtraKnownMarketplaces[marketplaceName]
			knownPath, err := a.homePath(".claude", "plugins", "known_marketplaces.json")
			if err == nil {
				known, err := readJSONFile[map[string]any](knownPath)
				if err == nil {
					_, registered := known[marketplaceName]
					market = market || registered
				}
			}
			missing = !settings.EnabledPlugins["felt@"+marketplaceName] || !market
		case "codex":
			cfg, err := a.readCodexConfig()
			if err != nil {
				continue
			}
			plugins, _ := cfg["plugins"].(map[string]interface{})
			for _, name := range codexBundleNames {
				plugin, _ := plugins[name+"@"+marketplaceName].(map[string]interface{})
				enabled, _ := plugin["enabled"].(bool)
				if !enabled {
					missing = true
				}
			}
			if codexSource(cfg) == "" {
				missing = true
			}
		default:
			continue
		}
		if missing {
			notes = append(notes, fmt.Sprintf("%s: felt plugin entries are missing; run `felt setup %s` to repair.", harness, harness))
		}
	}
	return notes
}
