package feltcli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
)

// The Antigravity CLI (agy) loads a native plugin from any directory under
// ~/.gemini/config/plugins/ that holds a plugin.json: its hooks.json at the
// plugin root, its skills/ beside it. felt owns plugins/felt/ and nothing
// else there. Each promoted generation carries the plugin at
// antigravityBundleDir, and setup copies it into place.

const antigravityBundleDir = "antigravity"

// antigravityHookEvents are the agy events Shuttle follows. SessionStart,
// PreInvocation and Stop take a flat list of handlers; the tool events take
// handler groups with a matcher.
var antigravityHookEvents = []string{"SessionStart", "PreInvocation", "PreToolUse", "PostToolUse", "Stop"}

// antigravityPluginFiles are what the plugin copies from the felt plugin
// source: the agy hook shim, the script it sources, and the skills.
var antigravityPluginFiles = []string{"hooks/agy.sh", "hooks/shuttle-bin.sh", "skills"}

func (a *app) setupAntigravityCmd() *cobra.Command {
	command := &cobra.Command{
		Use:   "antigravity",
		Short: "Install the felt plugin for the Antigravity CLI (agy)",
		Long: `Writes felt's native plugin for Google's Antigravity CLI (agy) to
~/.gemini/config/plugins/felt/: plugin.json, hooks.json that runs
` + "`shuttle hook antigravity`" + ` on the events Shuttle follows, and the felt
and shuttle skills. The source is chosen as for felt setup claude; felt
promotes it to a local generation, which the other harnesses carrying felt
follow, and copies that generation's agy plugin into place. agy loads it at
its next start. Re-running replaces it. --uninstall removes the directory.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			if uninstall, _ := cmd.Flags().GetBool("uninstall"); uninstall {
				dir, err := a.antigravityPluginDir()
				if err != nil {
					return err
				}
				if err := os.RemoveAll(dir); err != nil {
					return err
				}
				fmt.Fprintf(a.env.Stdout, "✓ Removed %s\n", dir)
				return nil
			}
			source, _ := cmd.Flags().GetString("source")
			resolved, err := a.resolveSetupSource(source)
			if err != nil {
				return err
			}
			return a.setupFromGeneration(resolved, a.installAntigravityPlugin)
		},
	}
	command.Flags().Bool("uninstall", false, "Remove the felt plugin from agy")
	command.Flags().String("source", "", "Path to felt repo checkout or plugin directory")
	return command
}

func (a *app) antigravityPluginDir() (string, error) {
	return a.homePath(".gemini", "config", "plugins", "felt")
}

// materializeAntigravityPlugin assembles agy's plugin at dir from the shared
// plugin directory.
func materializeAntigravityPlugin(dir, pluginDir string) error {
	// A source from before the agy shim existed would install hooks that run
	// nothing, and agy may read a failed tool hook as a refusal.
	if _, err := os.Stat(filepath.Join(pluginDir, "hooks", "agy.sh")); err != nil {
		return fmt.Errorf("%s has no hooks/agy.sh; pass --source <a felt checkout that has it>", pluginDir)
	}
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(dir, "hooks"), 0o755); err != nil {
		return err
	}
	for _, path := range antigravityPluginFiles {
		if err := copyTree(filepath.Join(pluginDir, path), filepath.Join(dir, path)); err != nil {
			return err
		}
	}
	manifest := map[string]string{
		"name":        "felt",
		"displayName": "Felt",
		"description": "felt and Shuttle for Antigravity: the felt and shuttle skills, and hooks that report this session to Shuttle and deliver its messages.",
	}
	// The shim bounds shuttle at five seconds, inside this timeout (seconds).
	hook := func(command string) []map[string]any {
		return []map[string]any{{"type": "command", "command": command, "timeout": 10}}
	}
	events := map[string]any{}
	for _, event := range antigravityHookEvents {
		if event == "PreToolUse" || event == "PostToolUse" {
			events[event] = []map[string]any{{"matcher": "*", "hooks": hook("./hooks/agy.sh tool")}}
		} else {
			events[event] = hook("./hooks/agy.sh")
		}
	}
	for name, value := range map[string]any{"plugin.json": manifest, "hooks.json": map[string]any{"felt-shuttle": events}} {
		data, err := json.MarshalIndent(value, "", "  ")
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(dir, name), append(data, '\n'), 0o644); err != nil {
			return err
		}
	}
	return nil
}

// installAntigravityPlugin copies the agy plugin of the generation promoted
// at current into place beside agy's other plugins and swaps it in, so agy
// never loads a half-written one.
func (a *app) installAntigravityPlugin(current string) error {
	expected, present, err := promotedGenerationForVerify(current)
	if err != nil {
		return err
	}
	if !present || expected.AntigravityPayloadSHA256 == "" {
		return fmt.Errorf("the generation at %s carries no agy plugin; rerun felt setup antigravity", current)
	}
	dir, err := a.antigravityPluginDir()
	if err != nil {
		return err
	}
	staging := dir + ".new"
	if err := os.RemoveAll(staging); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return err
	}
	if err := copyTree(filepath.Join(current, antigravityBundleDir), staging); err != nil {
		return err
	}
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	if err := os.Rename(staging, dir); err != nil {
		return err
	}
	fmt.Fprintf(a.env.Stdout, "✓ Installed the felt plugin for agy at %s\n", dir)
	return nil
}

// verifyAntigravityPlugin checks that agy's felt plugin is the copy the
// generation promoted at current carries.
func (a *app) verifyAntigravityPlugin(current string) error {
	expected, present, err := promotedGenerationForVerify(current)
	if err != nil || !present {
		return err
	}
	dir, err := a.antigravityPluginDir()
	if err != nil {
		return err
	}
	return verifyAntigravityGeneration(expected, dir)
}

func verifyAntigravityGeneration(expected pluginGenerationIdentity, dir string) error {
	if expected.AntigravityPayloadSHA256 == "" {
		return fmt.Errorf("the promoted generation carries no agy plugin; rerun felt setup antigravity")
	}
	digest, err := pluginPayloadDigest(dir)
	if err != nil {
		return fmt.Errorf("verifying antigravity plugin at %s: %w", dir, err)
	}
	if digest != expected.AntigravityPayloadSHA256 {
		return fmt.Errorf("verifying antigravity plugin at %s: payload digest %s disagrees with promoted %s", dir, digest, expected.AntigravityPayloadSHA256)
	}
	return nil
}

// collectAntigravityBundle reports felt's agy plugin: confirmed by
// `agy plugin list --json`, or from its directory, which is what agy loads,
// where agy is not on PATH.
func (a *app) collectAntigravityBundle() []ReceiptBundle {
	dir, err := a.antigravityPluginDir()
	if err != nil {
		return nil
	}
	bundle := ReceiptBundle{Name: "felt", Harness: "antigravity", Path: dir, Enabled: true, Status: receiptHealthy}
	if _, err := a.env.LookPath("agy"); err == nil {
		list := a.env.Command("agy", "plugin", "list", "--json")
		list.Env = append(a.env.Environ(), "AGY_CLI_DISABLE_AUTO_UPDATE=true")
		out, err := list.Output()
		var plugins []struct {
			Name    string `json:"name"`
			Enabled bool   `json:"enabled"`
			Path    string `json:"path"`
		}
		if err != nil || json.Unmarshal(out, &plugins) != nil {
			return []ReceiptBundle{{Harness: "antigravity", Enabled: true, Inspection: inspectionUnknown, Evidence: "agy plugin list unavailable", Status: receiptPartial, Repair: "repair `agy plugin list --json`, then rerun `felt setup antigravity`"}}
		}
		for _, plugin := range plugins {
			if plugin.Name != "felt" {
				continue
			}
			if !plugin.Enabled {
				return nil
			}
			bundle.Path, bundle.Inspection, bundle.Evidence = plugin.Path, inspectionConfirmed, "agy plugin list"
			return []ReceiptBundle{antigravityBundleFiles(bundle)}
		}
		return nil
	}
	if !isRegularFile(filepath.Join(dir, "plugin.json")) {
		return nil
	}
	bundle.Inspection, bundle.Evidence = inspectionConfigured, "plugin directory"
	return []ReceiptBundle{antigravityBundleFiles(bundle)}
}

func antigravityBundleFiles(b ReceiptBundle) ReceiptBundle {
	if !skillFilesCompatible(b.Path) {
		b.Status, b.Repair = receiptMissing, "restore the felt and shuttle skill files with `felt setup antigravity`"
	}
	return b
}

// antigravityHooksCompatible reports whether an agy plugin runs felt's shim
// on the events Shuttle follows.
func antigravityHooksCompatible(root string) bool {
	for _, name := range []string{"agy.sh", "shuttle-bin.sh"} {
		if !executableFile(filepath.Join(root, "hooks", name)) {
			return false
		}
	}
	doc, err := readJSONFile[map[string]map[string]any](filepath.Join(root, "hooks.json"))
	if err != nil {
		return false
	}
	for _, event := range antigravityHookEvents {
		if !hookValueContains(doc["felt-shuttle"][event], "agy.sh") {
			return false
		}
	}
	return true
}

var antigravityHarness = pluginHarness{
	name:    "antigravity",
	bundles: (*app).collectAntigravityBundle,
	install: (*app).installAntigravityPlugin,
	hooks:   antigravityHooksCompatible,
	verify: func(active pluginGenerationIdentity, bundle ReceiptBundle, _ string) error {
		return verifyAntigravityGeneration(active, bundle.Path)
	},
	capture: func(a *app, intent *pluginNativeIntent) error {
		dir, err := a.antigravityPluginDir()
		if err != nil {
			return err
		}
		installed := isRegularFile(filepath.Join(dir, "plugin.json"))
		intent.Antigravity = &installed
		return nil
	},
	follow: func(a *app, current string, intent *pluginNativeIntent) error {
		if intent.Antigravity == nil || !*intent.Antigravity || a.verifyAntigravityPlugin(current) == nil {
			return nil
		}
		return a.installAntigravityPlugin(current)
	},
	reconcile: func(a *app, current string, intent *pluginNativeIntent) error {
		if intent.Antigravity == nil {
			return nil
		}
		if *intent.Antigravity {
			if _, err := os.Stat(current); err != nil {
				return nil
			}
			if a.verifyAntigravityPlugin(current) == nil {
				return nil
			}
			return a.installAntigravityPlugin(current)
		}
		dir, err := a.antigravityPluginDir()
		if err != nil {
			return err
		}
		return os.RemoveAll(dir)
	},
}
