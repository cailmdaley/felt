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
// else there.

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
and shuttle skills. The plugin is copied from --source (a checkout or its
plugin directory), then $FELT_PLUGIN_DIR, then the marketplace Claude Code
cloned; agy loads it at its next start. Re-running replaces it.
--uninstall removes the directory.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			dir, err := a.antigravityPluginDir()
			if err != nil {
				return err
			}
			if uninstall, _ := cmd.Flags().GetBool("uninstall"); uninstall {
				if err := os.RemoveAll(dir); err != nil {
					return err
				}
				fmt.Fprintf(a.env.Stdout, "✓ Removed %s\n", dir)
				return nil
			}
			source, _ := cmd.Flags().GetString("source")
			pluginDir, err := a.findPluginDir(source)
			if err != nil {
				return err
			}
			if err := writeAntigravityPlugin(dir, pluginDir); err != nil {
				return err
			}
			fmt.Fprintf(a.env.Stdout, "✓ Installed the felt plugin for agy at %s\n", dir)
			return nil
		},
	}
	command.Flags().Bool("uninstall", false, "Remove the felt plugin from agy")
	command.Flags().String("source", "", "Path to felt repo checkout or plugin directory")
	return command
}

func (a *app) antigravityPluginDir() (string, error) {
	return a.homePath(".gemini", "config", "plugins", "felt")
}

// writeAntigravityPlugin assembles the plugin beside dir and swaps it in, so
// agy never loads a half-written one.
func writeAntigravityPlugin(dir, pluginDir string) error {
	// A source from before the agy shim existed would install hooks that run
	// nothing, and agy may read a failed tool hook as a refusal.
	if _, err := os.Stat(filepath.Join(pluginDir, "hooks", "agy.sh")); err != nil {
		return fmt.Errorf("%s has no hooks/agy.sh; pass --source <a felt checkout that has it>", pluginDir)
	}
	staging := dir + ".new"
	if err := os.RemoveAll(staging); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(staging, "hooks"), 0o755); err != nil {
		return err
	}
	for _, path := range antigravityPluginFiles {
		if err := copyTree(filepath.Join(pluginDir, path), filepath.Join(staging, path)); err != nil {
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
		if err := os.WriteFile(filepath.Join(staging, name), append(data, '\n'), 0o644); err != nil {
			return err
		}
	}
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	return os.Rename(staging, dir)
}

// refreshAntigravitySetupIfInstalled rewrites an installed agy plugin from
// the plugin source after an update.
func (a *app) refreshAntigravitySetupIfInstalled() {
	dir, err := a.antigravityPluginDir()
	if err != nil {
		return
	}
	if _, err := os.Stat(filepath.Join(dir, "plugin.json")); err != nil {
		return
	}
	fmt.Fprintln(a.env.Stdout)
	fmt.Fprintln(a.env.Stdout, "Refreshing the agy plugin...")
	pluginDir, err := a.findPluginDir("")
	if err == nil {
		err = writeAntigravityPlugin(dir, pluginDir)
	}
	if err != nil {
		fmt.Fprintf(a.env.Stdout, "agy plugin refresh failed: %v\n", err)
		fmt.Fprintln(a.env.Stdout, "Rerun `felt setup antigravity --source <checkout>` to retry.")
	}
}
