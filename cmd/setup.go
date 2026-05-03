package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

var setupCmd = &cobra.Command{
	Use:   "setup",
	Short: "Setup integrations",
	Long:  `Setup felt integrations with external tools.`,
}

var setupClaudeCmd = &cobra.Command{
	Use:   "claude",
	Short: "Install felt Claude Code plugin",
	Long: `Install the felt plugin for Claude Code.

Installs the felt plugin to ~/.claude/plugins/felt/ as a symlink to the
source plugin directory. The plugin declares SessionStart and PreToolUse hooks
and bundles the felt and ralph skills.

Resolution order for --source:
  1. --source <path>      path to a felt repo checkout (uses <path>/claude-plugin/)
                          or directly to the plugin directory (must contain plugin.json)
  2. $FELT_PLUGIN_DIR     env var pointing directly at the plugin directory
  3. ~/.claude/plugins/felt  already-installed plugin (idempotent re-install)

Use --uninstall to remove.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		source, _ := cmd.Flags().GetString("source")
		uninstall, _ := cmd.Flags().GetBool("uninstall")

		if uninstall {
			return uninstallPlugin()
		}

		pluginDir, err := findPluginDir(source)
		if err != nil {
			return err
		}

		if err := installPlugin(pluginDir); err != nil {
			return err
		}

		// Clean up legacy hooks-in-settings from previous installations.
		if err := uninstallClaudeHooks(); err != nil {
			fmt.Printf("· Could not remove legacy settings.json hooks (may not be present): %v\n", err)
		}

		fmt.Println()
		fmt.Println("Restart Claude Code for changes to take effect.")
		return nil
	},
}

var setupCodexCmd = &cobra.Command{
	Use:   "codex",
	Short: "Setup Codex integration",
	Long: `Install felt hooks and skills for Codex.

Installs felt hooks into Codex's hooks.json and symlinks the felt and ralph
skills from the plugin directory into ~/.agents/skills/.

Resolution order for --source:
  1. --source <path>      path to a felt repo checkout or plugin directory
  2. $FELT_PLUGIN_DIR     env var pointing at the plugin directory
  3. ~/.claude/plugins/felt  if the plugin is installed for Claude Code

Use --uninstall to remove.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		source, _ := cmd.Flags().GetString("source")
		uninstall, _ := cmd.Flags().GetBool("uninstall")

		if uninstall {
			return uninstallCodexHooks()
		}

		if err := installCodexHooks(); err != nil {
			return err
		}

		pluginDir, err := findPluginDir(source)
		if err != nil {
			fmt.Printf("· Could not find plugin directory for skills: %v\n", err)
			fmt.Println("  Install the plugin first with: felt setup claude --source <path>")
			fmt.Println()
		} else {
			skillsTarget := filepath.Join(os.Getenv("HOME"), ".agents", "skills")
			if err := linkSkillsFromPlugin(skillsTarget, pluginDir); err != nil {
				fmt.Printf("warning: could not link skills: %v\n", err)
			}
		}

		fmt.Println()
		fmt.Println("You may want to put something like the following in your AGENTS.md, adjusted to match your work style:")
		fmt.Println()
		fmt.Println(claudeMDSnippet())
		return nil
	},
}

var setupSkillsCmd = &cobra.Command{
	Use:   "skills",
	Short: "Link felt skills to a target directory",
	Long: `Link felt skills (felt, ralph) from the plugin directory into a target directory.

By default, links to ~/.claude/skills. Use --target to specify a different directory.
Existing entries are replaced.

Resolution order for --source:
  1. --source <path>      path to a felt repo checkout or plugin directory
  2. $FELT_PLUGIN_DIR     env var pointing at the plugin directory
  3. ~/.claude/plugins/felt  if the plugin is installed`,
	RunE: func(cmd *cobra.Command, args []string) error {
		target, _ := cmd.Flags().GetString("target")
		source, _ := cmd.Flags().GetString("source")

		if target == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return err
			}
			target = filepath.Join(home, ".claude", "skills")
		}

		pluginDir, err := findPluginDir(source)
		if err != nil {
			return err
		}

		return linkSkillsFromPlugin(target, pluginDir)
	},
}

func init() {
	setupClaudeCmd.Flags().Bool("uninstall", false, "Remove felt plugin from Claude Code")
	setupClaudeCmd.Flags().String("source", "", "Path to felt repo checkout or plugin directory")
	setupCodexCmd.Flags().Bool("uninstall", false, "Remove felt hooks from Codex")
	setupCodexCmd.Flags().String("source", "", "Path to felt repo checkout or plugin directory")
	setupSkillsCmd.Flags().String("target", "", "Target directory (default: ~/.claude/skills)")
	setupSkillsCmd.Flags().String("source", "", "Path to felt repo checkout or plugin directory")
	setupCmd.AddCommand(setupClaudeCmd)
	setupCmd.AddCommand(setupCodexCmd)
	setupCmd.AddCommand(setupSkillsCmd)
	rootCmd.AddCommand(setupCmd)
}

// hasPluginManifest returns true if dir contains a plugin manifest at
// .claude-plugin/plugin.json (the standard plugin layout).
func hasPluginManifest(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, ".claude-plugin", "plugin.json"))
	return err == nil
}

// findPluginDir resolves the felt claude-plugin directory.
// Resolution order: explicit source arg, $FELT_PLUGIN_DIR, ~/.claude/plugins/felt.
func findPluginDir(source string) (string, error) {
	if source != "" {
		// Could be a felt repo checkout (has claude-plugin/ subdir) or the plugin dir itself.
		repoPlugin := filepath.Join(source, "claude-plugin")
		if hasPluginManifest(repoPlugin) {
			return repoPlugin, nil
		}
		if hasPluginManifest(source) {
			return source, nil
		}
		return "", fmt.Errorf("no plugin directory found at %q\n  Expected claude-plugin/.claude-plugin/plugin.json", source)
	}

	if env := os.Getenv("FELT_PLUGIN_DIR"); env != "" {
		if hasPluginManifest(env) {
			return env, nil
		}
		return "", fmt.Errorf("$FELT_PLUGIN_DIR=%q: no .claude-plugin/plugin.json found there", env)
	}

	home, _ := os.UserHomeDir()
	installed := filepath.Join(home, ".claude", "plugins", "felt")
	if hasPluginManifest(installed) {
		return installed, nil
	}

	return "", fmt.Errorf("could not find felt plugin directory\n" +
		"  Pass --source <checkout> (e.g. felt setup claude --source ~/src/felt)\n" +
		"  or set $FELT_PLUGIN_DIR, or install first via the Claude Code plugin marketplace")
}

// installPlugin symlinks the felt plugin from src to ~/.claude/plugins/felt/.
func installPlugin(src string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	pluginsDir := filepath.Join(home, ".claude", "plugins")
	if err := os.MkdirAll(pluginsDir, 0755); err != nil {
		return fmt.Errorf("creating plugins directory: %w", err)
	}

	dest := filepath.Join(pluginsDir, "felt")

	// If dest already resolves to the same source, it's a no-op.
	if existing, err := os.Readlink(dest); err == nil && existing == src {
		fmt.Printf("· Plugin already linked: %s → %s\n", dest, src)
		return nil
	}

	if err := os.RemoveAll(dest); err != nil {
		return fmt.Errorf("removing existing plugin at %s: %w", dest, err)
	}

	abs, err := filepath.Abs(src)
	if err != nil {
		return err
	}
	if err := os.Symlink(abs, dest); err != nil {
		return fmt.Errorf("symlinking plugin: %w", err)
	}
	fmt.Printf("✓ Installed plugin: %s → %s\n", dest, abs)
	return nil
}

// uninstallPlugin removes the felt plugin from ~/.claude/plugins/felt/.
func uninstallPlugin() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	dest := filepath.Join(home, ".claude", "plugins", "felt")
	if _, err := os.Lstat(dest); os.IsNotExist(err) {
		fmt.Println("No felt plugin found at ~/.claude/plugins/felt")
	} else {
		if err := os.RemoveAll(dest); err != nil {
			return fmt.Errorf("removing plugin: %w", err)
		}
		fmt.Println("✓ Removed plugin from ~/.claude/plugins/felt")
	}

	// Also clean up legacy settings.json hooks.
	if err := uninstallClaudeHooks(); err == nil {
		fmt.Println("✓ Removed legacy settings.json hooks")
	}

	fmt.Println()
	fmt.Println("Restart Claude Code for changes to take effect.")
	return nil
}

// linkSkillsFromPlugin symlinks each skill in <pluginDir>/skills/ into targetDir.
func linkSkillsFromPlugin(targetDir, pluginDir string) error {
	skillsDir := filepath.Join(pluginDir, "skills")
	entries, err := os.ReadDir(skillsDir)
	if err != nil {
		return fmt.Errorf("reading plugin skills from %s: %w", skillsDir, err)
	}

	if err := os.MkdirAll(targetDir, 0755); err != nil {
		return fmt.Errorf("creating target directory %s: %w", targetDir, err)
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		src, err := filepath.Abs(filepath.Join(skillsDir, name))
		if err != nil {
			return err
		}
		dest := filepath.Join(targetDir, name)

		if existing, err := os.Readlink(dest); err == nil && existing == src {
			fmt.Printf("· Skill already linked: %s\n", name)
			continue
		}

		os.RemoveAll(dest)
		if err := os.Symlink(src, dest); err != nil {
			return fmt.Errorf("linking skill %s: %w", name, err)
		}
		fmt.Printf("✓ Linked skill: %s → %s\n", name, src)
	}
	return nil
}

// claudeMDSnippet returns the suggested CLAUDE.md / AGENTS.md snippet.
func claudeMDSnippet() string {
	fence := "```"
	return "## felt\n\n" +
		"Fibers are concerns (tasks, decisions, questions, findings). " +
		"Each fiber lives at `.felt/<path>/<slug>.md` with YAML frontmatter and plain markdown body content. " +
		"Containment comes from directories, narrative connections come from `[[wikilinks]]`, and structured frontmatter (decisions, inputs, outputs, insights) accretes as the work becomes computationally concrete. " +
		"`.felt/` also opens as a valid Obsidian vault, with Dataview queries over frontmatter fields. " +
		"Filing costs nothing; forgetting costs an investigation or a hallucination.\n\n" +
		"**Rhythm.** File as things come into focus, without asking. After you respond, while the user reads, accrete structure. Close with an outcome that stands alone.\n" +
		fence + "bash\n" +
		"felt add covariance-method \"Covariance method\"          # came into focus\n" +
		"felt edit covariance-method -s active                    # entered tracking\n" +
		"felt edit covariance-method -o \"Jackknife is stable\"   # closed with outcome\n" +
		fence + "\n\n" +
		"**Discipline.** Names are short, concrete handles for the concern. " +
		"Path IDs like `bao-analysis/damping-prior` are first-class; bare slugs resolve only when unambiguous. " +
		"Outcomes say not just *what* but *why*. " +
		"Decisions get their own fibers; methodology questions belong in decision fibers, not specs. " +
		"Follow the data: curious, not confirmatory.\n"
}

func codexHooksPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("getting home directory: %w", err)
	}
	return filepath.Join(home, ".codex", "hooks.json"), nil
}

func installCodexHooks() error {
	hooksPath, err := codexHooksPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(hooksPath), 0755); err != nil {
		return fmt.Errorf("creating .codex directory: %w", err)
	}

	settings := make(map[string]interface{})
	if data, err := os.ReadFile(hooksPath); err == nil {
		if err := json.Unmarshal(data, &settings); err != nil {
			return fmt.Errorf("parsing hooks.json: %w", err)
		}
	}

	hooks, ok := settings["hooks"].(map[string]interface{})
	if !ok {
		hooks = make(map[string]interface{})
		settings["hooks"] = hooks
	}

	if addHook(hooks, "SessionStart", "", "felt hook session") {
		fmt.Println("✓ Added SessionStart hook: felt hook session")
	} else {
		fmt.Println("· SessionStart hook already installed")
	}

	if addHook(hooks, "PreToolUse", "", "felt hook remind") {
		fmt.Println("✓ Added PreToolUse hook: felt hook remind")
	} else {
		fmt.Println("· PreToolUse hook already installed")
	}

	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling hooks.json: %w", err)
	}
	if err := os.WriteFile(hooksPath, data, 0644); err != nil {
		return fmt.Errorf("writing hooks.json: %w", err)
	}

	_ = uninstallCodexWrapper()
	fmt.Println()
	fmt.Printf("Hooks: %s\n", hooksPath)
	fmt.Println("If native hooks are still disabled, run: codex features enable codex_hooks")
	return nil
}

func uninstallCodexHooks() error {
	hooksPath, err := codexHooksPath()
	if err != nil {
		return err
	}

	data, err := os.ReadFile(hooksPath)
	if err != nil {
		fmt.Println("No Codex hooks.json found")
		_ = uninstallCodexWrapper()
		return nil
	}

	var settings map[string]interface{}
	if err := json.Unmarshal(data, &settings); err != nil {
		return fmt.Errorf("parsing hooks.json: %w", err)
	}

	hooks, ok := settings["hooks"].(map[string]interface{})
	if !ok {
		fmt.Println("No hooks found")
		_ = uninstallCodexWrapper()
		return nil
	}

	removed := false
	if removeHook(hooks, "SessionStart", "felt hook session") {
		fmt.Println("✓ Removed SessionStart hook")
		removed = true
	}
	if removeHook(hooks, "PreToolUse", "felt hook remind") {
		fmt.Println("✓ Removed PreToolUse hook")
		removed = true
	}

	if removed {
		data, err = json.MarshalIndent(settings, "", "  ")
		if err != nil {
			return fmt.Errorf("marshaling hooks.json: %w", err)
		}
		if err := os.WriteFile(hooksPath, data, 0644); err != nil {
			return fmt.Errorf("writing hooks.json: %w", err)
		}
		fmt.Printf("Hooks: %s\n", hooksPath)
	} else {
		fmt.Println("No felt Codex hooks found")
	}

	_ = uninstallCodexWrapper()
	return nil
}

// claudeSettingsPath returns the path to Claude Code's settings.json
func claudeSettingsPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("getting home directory: %w", err)
	}
	return filepath.Join(home, ".claude", "settings.json"), nil
}

// uninstallClaudeHooks removes felt hooks from Claude Code settings.json.
// Used for backward-compat cleanup when migrating from the old embed-based install.
func uninstallClaudeHooks() error {
	settingsPath, err := claudeSettingsPath()
	if err != nil {
		return err
	}

	data, err := os.ReadFile(settingsPath)
	if err != nil {
		return nil // no settings file; nothing to clean
	}

	var settings map[string]interface{}
	if err := json.Unmarshal(data, &settings); err != nil {
		return fmt.Errorf("parsing settings.json: %w", err)
	}

	hooks, ok := settings["hooks"].(map[string]interface{})
	if !ok {
		return nil
	}

	removed := false
	if removeHook(hooks, "SessionStart", "felt hook session") {
		removed = true
	}
	if removeHook(hooks, "PreToolUse", "felt hook remind") {
		removed = true
	}
	consciencePath := filepath.Join(filepath.Dir(settingsPath), "hooks", "felt-conscience.sh")
	if removeHook(hooks, "Stop", consciencePath) {
		removed = true
	}

	if !removed {
		return nil
	}

	data, err = json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling settings: %w", err)
	}
	return os.WriteFile(settingsPath, data, 0644)
}

// addHook adds a hook command to an event if not already present.
// matcher is optional (empty string for no matcher).
// Returns true if hook was added.
func addHook(hooks map[string]interface{}, event, matcher, command string) bool {
	eventHooks, ok := hooks[event].([]interface{})
	if !ok {
		eventHooks = []interface{}{}
	}

	// Check if hook already exists
	for _, hook := range eventHooks {
		hookMap, ok := hook.(map[string]interface{})
		if !ok {
			continue
		}

		// Check matcher
		hookMatcher, _ := hookMap["matcher"].(string)
		if hookMatcher != matcher {
			continue
		}

		// Check commands
		cmds, ok := hookMap["hooks"].([]interface{})
		if !ok {
			continue
		}

		for _, cmd := range cmds {
			cmdMap, ok := cmd.(map[string]interface{})
			if !ok {
				continue
			}
			if cmdMap["command"] == command {
				return false // Already exists
			}
		}
	}

	// Add new hook
	newHook := map[string]interface{}{
		"hooks": []interface{}{
			map[string]interface{}{
				"type":    "command",
				"command": command,
			},
		},
	}
	if matcher != "" {
		newHook["matcher"] = matcher
	}

	eventHooks = append(eventHooks, newHook)
	hooks[event] = eventHooks
	return true
}

// removeHook removes a hook command from an event.
// Returns true if hook was removed.
func removeHook(hooks map[string]interface{}, event, command string) bool {
	eventHooks, ok := hooks[event].([]interface{})
	if !ok {
		return false
	}

	filtered := make([]interface{}, 0, len(eventHooks))
	removed := false

	for _, hook := range eventHooks {
		hookMap, ok := hook.(map[string]interface{})
		if !ok {
			filtered = append(filtered, hook)
			continue
		}

		cmds, ok := hookMap["hooks"].([]interface{})
		if !ok {
			filtered = append(filtered, hook)
			continue
		}

		// Check if this hook has the command we want to remove
		hasCommand := false
		for _, cmd := range cmds {
			cmdMap, ok := cmd.(map[string]interface{})
			if !ok {
				continue
			}
			if cmdMap["command"] == command {
				hasCommand = true
				break
			}
		}

		if hasCommand {
			removed = true
			// Don't add to filtered
		} else {
			filtered = append(filtered, hook)
		}
	}

	if len(filtered) == 0 {
		delete(hooks, event)
	} else {
		hooks[event] = filtered
	}

	return removed
}

// rcFilePath returns the shell RC file path based on $SHELL.
func rcFilePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("getting home directory: %w", err)
	}
	shell := os.Getenv("SHELL")
	if strings.Contains(shell, "zsh") {
		return filepath.Join(home, ".zshrc"), nil
	}
	return filepath.Join(home, ".bashrc"), nil
}

const codexSentinelStart = "# felt integration — added by felt setup codex"
const codexSentinelEnd = "# end felt integration"

const codexWrapper = `# felt integration — added by felt setup codex
function codex() {
    local felt_context
    felt_context=$(felt hook session 2>/dev/null || true)
    if [ -n "$felt_context" ]; then
        command codex --config "developer_instructions=$felt_context" "$@"
    else
        command codex "$@"
    fi
}
# end felt integration`

func installCodexWrapper() error {
	rcPath, err := rcFilePath()
	if err != nil {
		return err
	}

	// Read existing content
	content := ""
	if data, err := os.ReadFile(rcPath); err == nil {
		content = string(data)
	}

	// Idempotent: already installed?
	if strings.Contains(content, codexSentinelStart) {
		fmt.Printf("· codex wrapper already installed in %s\n", rcPath)
		return nil
	}

	// Append
	sep := ""
	if len(content) > 0 && !strings.HasSuffix(content, "\n") {
		sep = "\n"
	}
	newContent := content + sep + "\n" + codexWrapper + "\n"

	if err := os.WriteFile(rcPath, []byte(newContent), 0644); err != nil {
		return fmt.Errorf("writing %s: %w", rcPath, err)
	}

	fmt.Printf("✓ Installed codex wrapper in %s\n", rcPath)
	fmt.Printf("  Run: source %s\n", rcPath)
	return nil
}

func uninstallCodexWrapper() error {
	rcPath, err := rcFilePath()
	if err != nil {
		return err
	}

	data, err := os.ReadFile(rcPath)
	if err != nil {
		return nil // No RC file; nothing to do.
	}

	content := string(data)
	if !strings.Contains(content, codexSentinelStart) {
		return nil
	}

	// Remove block between sentinels (inclusive)
	var out []string
	inside := false
	for _, line := range strings.Split(content, "\n") {
		if strings.TrimSpace(line) == codexSentinelStart {
			inside = true
			// Also remove the blank line before the sentinel if present
			if len(out) > 0 && out[len(out)-1] == "" {
				out = out[:len(out)-1]
			}
			continue
		}
		if inside {
			if strings.TrimSpace(line) == codexSentinelEnd {
				inside = false
			}
			continue
		}
		out = append(out, line)
	}

	newContent := strings.Join(out, "\n")
	if err := os.WriteFile(rcPath, []byte(newContent), 0644); err != nil {
		return fmt.Errorf("writing %s: %w", rcPath, err)
	}

	fmt.Printf("✓ Removed codex wrapper from %s\n", rcPath)
	return nil
}
