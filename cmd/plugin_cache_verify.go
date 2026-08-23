package cmd

// A zero exit status from a native CLI is a claim, not proof. Before a
// promotion commits — and with it discards the last known-good `previous`
// copy — the cache the harness reports as loaded must carry the same sealed
// generation marker and payload digest as the promoted current. Verification
// runs inside the install callback, so a failure rolls the filesystem back
// and restores the prior native state like any other rejected candidate.

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
)

// verifyClaudeLoadedGeneration checks the cache `claude plugin list --json`
// reports as installed against the promoted generation at current.
func verifyClaudeLoadedGeneration(current string) error {
	expected, present, err := promotedGenerationForVerify(current)
	if err != nil || !present {
		return err
	}
	out, err := exec.Command("claude", "plugin", "list", "--json").Output()
	if err != nil {
		return fmt.Errorf("verifying Claude cache: claude plugin list: %w", err)
	}
	var plugins []receiptInstalledPlugin
	if err := json.Unmarshal(out, &plugins); err != nil {
		return fmt.Errorf("verifying Claude cache: decoding plugin list: %w", err)
	}
	ref := "felt@" + marketplaceName
	for _, plugin := range plugins {
		if plugin.PluginID != ref && plugin.ID != ref {
			continue
		}
		if !plugin.Enabled {
			// Enabled-ness is a user preference stored in settings.json that
			// survives uninstall+install; refusing here would make setup
			// permanently impossible for a deliberately disabled plugin, and
			// silently flipping the preference would be worse. Verify the
			// materialized bytes, and say loudly that nothing loads until the
			// user re-enables.
			fmt.Printf("⚠ %s is installed but disabled; the verified plugin will not load until you run `claude plugin enable %s`\n", ref, ref)
		}
		if plugin.InstallPath == "" {
			return fmt.Errorf("verifying Claude cache: plugin list reports %s without an install path", ref)
		}
		return verifyLoadedGeneration("claude", expected, plugin.InstallPath)
	}
	return fmt.Errorf("verifying Claude cache: plugin list does not report %s as installed", ref)
}

// verifyCodexLoadedGeneration checks the cache `codex plugin list --json`
// reports as installed against the promoted generation at current.
func verifyCodexLoadedGeneration(current string) error {
	expected, present, err := promotedGenerationForVerify(current)
	if err != nil || !present {
		return err
	}
	out, err := runCodexCLIQuiet("plugin", "list", "--json")
	if err != nil {
		return fmt.Errorf("verifying Codex cache: codex plugin list: %w", err)
	}
	var document struct {
		Installed []receiptInstalledPlugin `json:"installed"`
	}
	if err := json.Unmarshal([]byte(out), &document); err != nil {
		return fmt.Errorf("verifying Codex cache: decoding plugin list: %w", err)
	}
	for _, plugin := range document.Installed {
		if plugin.PluginID != codexPluginRef && plugin.ID != codexPluginRef {
			continue
		}
		if !plugin.Enabled {
			// Same call as the Claude path: a disable is user preference, not
			// a materialization failure; verify the bytes and surface the gap.
			fmt.Printf("⚠ %s is installed but disabled; the verified plugin will not load until you re-enable it in Codex\n", codexPluginRef)
		}
		if plugin.Source.Path == "" {
			return fmt.Errorf("verifying Codex cache: plugin list reports %s without a cache path", codexPluginRef)
		}
		return verifyLoadedGeneration("codex", expected, plugin.Source.Path)
	}
	return fmt.Errorf("verifying Codex cache: plugin list does not report %s as installed", codexPluginRef)
}

// promotedGenerationForVerify reads the sealed marker for a promoted path.
// A missing marker means a legacy generation restored during recovery: those
// predate sealing and cannot be verified, so verification is skipped rather
// than turning recovery into a permanent failure. Every candidate staged by
// this build is sealed before promotion, so a fresh install always verifies.
func promotedGenerationForVerify(current string) (pluginGenerationIdentity, bool, error) {
	root := filepath.Join(current, "claude-plugin")
	if !isRegularFile(filepath.Join(root, pluginGenerationMarkerName)) {
		return pluginGenerationIdentity{}, false, nil
	}
	expected, err := validatePluginGeneration(root)
	if err != nil {
		return pluginGenerationIdentity{}, false, fmt.Errorf("verifying promoted generation at %s: %w", root, err)
	}
	return expected, true, nil
}

func verifyLoadedGeneration(harness string, expected pluginGenerationIdentity, loadedPath string) error {
	loaded, err := validatePluginGeneration(loadedPath)
	if err != nil {
		return fmt.Errorf("verifying %s cache at %s: %w", harness, loadedPath, err)
	}
	if status, repair := comparePluginGenerations(expected, loaded); status != receiptHealthy {
		return fmt.Errorf("verifying %s cache at %s: %s", harness, loadedPath, repair)
	}
	return nil
}
