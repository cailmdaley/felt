package cmd

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

//go:embed skills
var embeddedSkills embed.FS

var setupCmd = &cobra.Command{
	Use:   "setup",
	Short: "Setup integrations",
	Long:  `Setup felt integrations with external tools.`,
}

var setupClaudeCmd = &cobra.Command{
	Use:   "claude",
	Short: "Setup Claude Code integration",
	Long: `Install felt hooks into Claude Code settings.

Adds:
  - SessionStart: felt hook session (shows active/ready fibers)

Use --uninstall to remove the hooks.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		uninstall, _ := cmd.Flags().GetBool("uninstall")
		if uninstall {
			return uninstallClaudeHooks()
		}
		if err := installClaudeHooks(); err != nil {
			return err
		}
		fmt.Println()
		skillsTarget := filepath.Join(os.Getenv("HOME"), ".claude", "skills")
		if err := installSkills(skillsTarget); err != nil {
			fmt.Printf("warning: could not install skills: %v\n", err)
		}
		fmt.Println()
		fmt.Println("You may want to put something like the following in your CLAUDE.md, adjusted to match your work style:")
		fmt.Println()
		fmt.Println(claudeMDSnippet())
		return nil
	},
}

var setupCodexCmd = &cobra.Command{
	Use:   "codex",
	Short: "Setup Codex integration",
	Long: `Install a codex() shell wrapper in your RC file.

The wrapper injects felt context into every Codex session via --config.
Detects shell from $SHELL (zsh → ~/.zshrc, bash → ~/.bashrc).

Use --uninstall to remove it.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		uninstall, _ := cmd.Flags().GetBool("uninstall")
		if uninstall {
			return uninstallCodexWrapper()
		}
		if err := installCodexWrapper(); err != nil {
			return err
		}
		fmt.Println()
		skillsTarget := filepath.Join(os.Getenv("HOME"), ".agents", "skills")
		if err := installSkills(skillsTarget); err != nil {
			fmt.Printf("warning: could not install skills: %v\n", err)
		}
		fmt.Println()
		fmt.Println("You may want to put something like the following in your AGENTS.md, adjusted to match your work style:")
		fmt.Println()
		fmt.Println(claudeMDSnippet())
		return nil
	},
}

func init() {
	setupClaudeCmd.Flags().Bool("uninstall", false, "Remove felt hooks from Claude Code")
	setupCodexCmd.Flags().Bool("uninstall", false, "Remove codex wrapper from RC file")
	setupCmd.AddCommand(setupClaudeCmd)
	setupCmd.AddCommand(setupCodexCmd)
	rootCmd.AddCommand(setupCmd)
}

// claudeMDSnippet returns the suggested CLAUDE.md / AGENTS.md snippet.
func claudeMDSnippet() string {
	fence := "```"
	return "## felt\n\n" +
		"Fibers are concerns — tasks, decisions, questions — strung in a DAG. " +
		"Body is the content; outcome is the conclusion. " +
		"`felt upstream` shows what a decision rests on; `felt downstream` shows what breaks if it changes. " +
		"A missing causal link costs an investigation; a fiber costs nothing.\n\n" +
		"**Rhythm.** File before you start, comment as you go, close with an outcome.\n" +
		fence + "bash\n" +
		"felt \"what I'm doing\"                              # before starting\n" +
		"felt comment <id> \"tried X, hit Y\"                 # as you go\n" +
		"felt edit <id> -s closed -o \"X works because...\"   # close with outcome\n" +
		fence + "\n\n" +
		"**Discipline.** Titles are 2–3 word DAG node labels — terse, like commit subjects. " +
		"Outcomes say not just *what* but *why*, pointing back through the DAG. " +
		"Decisions get their own fibers; methodology questions belong in decision fibers, not specs. " +
		"Follow the data: curious, not confirmatory.\n"
}

// installSkills extracts bundled skills directly into targetDir (e.g. ~/.claude/skills).
func installSkills(targetDir string) error {
	return fs.WalkDir(embeddedSkills, "skills", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		// path is like "skills/felt/SKILL.md" — strip leading "skills/"
		rel, err := filepath.Rel("skills", path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		target := filepath.Join(targetDir, rel)

		if d.IsDir() {
			return os.MkdirAll(target, 0755)
		}

		// Skip if already exists
		if _, err := os.Stat(target); err == nil {
			return nil
		}

		data, err := embeddedSkills.ReadFile(path)
		if err != nil {
			return err
		}

		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return err
		}

		mode := fs.FileMode(0644)
		if strings.Contains(path, "/scripts/") {
			mode = 0755
		}

		if err := os.WriteFile(target, data, mode); err != nil {
			return err
		}

		// Print once per top-level skill directory
		parts := strings.SplitN(rel, string(filepath.Separator), 2)
		if len(parts) == 2 && parts[1] == "SKILL.md" {
			fmt.Printf("✓ Installed skill: %s\n", parts[0])
		}
		return nil
	})
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
		fmt.Println("No RC file found")
		return nil
	}

	content := string(data)
	if !strings.Contains(content, codexSentinelStart) {
		fmt.Println("No felt codex wrapper found")
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


// claudeSettingsPath returns the path to Claude Code's settings.json
func claudeSettingsPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("getting home directory: %w", err)
	}
	return filepath.Join(home, ".claude", "settings.json"), nil
}

// installClaudeHooks adds felt hooks to Claude Code settings
func installClaudeHooks() error {
	settingsPath, err := claudeSettingsPath()
	if err != nil {
		return err
	}

	// Ensure .claude directory exists
	if err := os.MkdirAll(filepath.Dir(settingsPath), 0755); err != nil {
		return fmt.Errorf("creating .claude directory: %w", err)
	}

	// Load existing settings or create new
	settings := make(map[string]interface{})
	if data, err := os.ReadFile(settingsPath); err == nil {
		if err := json.Unmarshal(data, &settings); err != nil {
			return fmt.Errorf("parsing settings.json: %w", err)
		}
	}

	// Get or create hooks section
	hooks, ok := settings["hooks"].(map[string]interface{})
	if !ok {
		hooks = make(map[string]interface{})
		settings["hooks"] = hooks
	}

	// Add SessionStart hook
	if addHook(hooks, "SessionStart", "", "felt hook session") {
		fmt.Println("✓ Added SessionStart hook: felt hook session")
	} else {
		fmt.Println("· SessionStart hook already installed")
	}

	// Write settings back
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling settings: %w", err)
	}

	if err := os.WriteFile(settingsPath, data, 0644); err != nil {
		return fmt.Errorf("writing settings.json: %w", err)
	}

	fmt.Println()
	fmt.Printf("Settings: %s\n", settingsPath)
	fmt.Println("Restart Claude Code for changes to take effect.")
	return nil
}

// uninstallClaudeHooks removes felt hooks from Claude Code settings
func uninstallClaudeHooks() error {
	settingsPath, err := claudeSettingsPath()
	if err != nil {
		return err
	}

	data, err := os.ReadFile(settingsPath)
	if err != nil {
		fmt.Println("No settings file found")
		return nil
	}

	var settings map[string]interface{}
	if err := json.Unmarshal(data, &settings); err != nil {
		return fmt.Errorf("parsing settings.json: %w", err)
	}

	hooks, ok := settings["hooks"].(map[string]interface{})
	if !ok {
		fmt.Println("No hooks found")
		return nil
	}

	// Remove felt hooks
	removed := false
	if removeHook(hooks, "SessionStart", "felt hook session") {
		fmt.Println("✓ Removed SessionStart hook")
		removed = true
	}

	if !removed {
		fmt.Println("No felt hooks found to remove")
		return nil
	}

	// Write settings back
	data, err = json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling settings: %w", err)
	}

	if err := os.WriteFile(settingsPath, data, 0644); err != nil {
		return fmt.Errorf("writing settings.json: %w", err)
	}

	fmt.Println()
	fmt.Println("Restart Claude Code for changes to take effect.")
	return nil
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
