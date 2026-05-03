package cmd

import (
	"bytes"
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
  - PreToolUse: felt hook remind (per-session marker; pass-through)

Use --uninstall to remove the hooks.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		uninstall, _ := cmd.Flags().GetBool("uninstall")
		if uninstall {
			return uninstallClaudeHooks()
		}
		updateSkills, _ := cmd.Flags().GetBool("update-skills")
		if err := installClaudeHooks(); err != nil {
			return err
		}
		fmt.Println()
		skillsTarget := filepath.Join(os.Getenv("HOME"), ".claude", "skills")
		if err := installSkills(skillsTarget, updateSkills); err != nil {
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
	Long: `Install felt hooks into Codex native hooks.json.

Adds:
  - SessionStart: felt hook session (shows active/recent fibers)
  - PreToolUse: felt hook remind (per-session marker; pass-through)

Also attempts to remove the legacy codex() shell wrapper if present.

Use --uninstall to remove the hooks.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		uninstall, _ := cmd.Flags().GetBool("uninstall")
		if uninstall {
			return uninstallCodexHooks()
		}
		updateSkills, _ := cmd.Flags().GetBool("update-skills")
		if err := installCodexHooks(); err != nil {
			return err
		}
		fmt.Println()
		skillsTarget := filepath.Join(os.Getenv("HOME"), ".agents", "skills")
		if err := installSkills(skillsTarget, updateSkills); err != nil {
			fmt.Printf("warning: could not install skills: %v\n", err)
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
	Short: "Install felt skills to a target directory",
	Long:  bundledSkillsLong(),
	RunE: func(cmd *cobra.Command, args []string) error {
		target, _ := cmd.Flags().GetString("target")
		update, _ := cmd.Flags().GetBool("update")
		linkSrc, _ := cmd.Flags().GetString("link")
		if target == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return err
			}
			target = filepath.Join(home, ".claude", "skills")
		}
		if linkSrc != "" {
			if err := setDevSource(linkSrc); err != nil {
				fmt.Printf("warning: could not save dev source path: %v\n", err)
			}
			return linkSkills(target, linkSrc)
		}
		return installSkills(target, update)
	},
}

func init() {
	setupClaudeCmd.Flags().Bool("uninstall", false, "Remove felt hooks from Claude Code")
	setupClaudeCmd.Flags().Bool("update-skills", false, "Update existing skills (overwrites local changes)")
	setupCodexCmd.Flags().Bool("uninstall", false, "Remove felt hooks from Codex")
	setupCodexCmd.Flags().Bool("update-skills", false, "Update existing skills (overwrites local changes)")
	setupSkillsCmd.Flags().String("target", "", "Target directory (default: ~/.claude/skills)")
	setupSkillsCmd.Flags().Bool("update", false, "Update existing skills (overwrites local changes)")
	setupSkillsCmd.Flags().String("link", "", "Symlink skills from a felt source checkout (dev mode)")
	setupCmd.AddCommand(setupClaudeCmd)
	setupCmd.AddCommand(setupCodexCmd)
	setupCmd.AddCommand(setupSkillsCmd)
	rootCmd.AddCommand(setupCmd)
}

func bundledSkillsLong() string {
	return fmt.Sprintf(`Install felt's bundled skills (%s) to a target directory.

By default, installs to ~/.claude/skills. Use --target to specify a different directory.
For Codex, a typical target is ~/.agents/skills.
Existing files are not overwritten unless --update is passed.`, strings.Join(bundledSkillNames(), ", "))
}

func bundledSkillNames() []string {
	entries, err := fs.ReadDir(embeddedSkills, "skills")
	if err != nil {
		return []string{"felt", "ralph"}
	}

	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			names = append(names, entry.Name())
		}
	}
	return names
}

// removeBrokenSkillSymlinks removes top-level entries in targetDir whose name
// matches a bundled skill and which are symlinks to a path that no longer
// resolves. Intact symlinks (e.g. a live `felt setup skills --link` dev
// install) and regular directories/files are left alone.
func removeBrokenSkillSymlinks(targetDir string) error {
	entries, err := fs.ReadDir(embeddedSkills, "skills")
	if err != nil {
		return nil // no bundled skills; nothing to heal
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		path := filepath.Join(targetDir, entry.Name())
		info, err := os.Lstat(path)
		if err != nil {
			continue // doesn't exist — nothing to heal
		}
		if info.Mode()&os.ModeSymlink == 0 {
			continue // regular dir/file — leave alone
		}
		if _, err := os.Stat(path); err == nil {
			continue // symlink resolves — leave alone (user may have --link'd)
		}
		if err := os.Remove(path); err != nil {
			return fmt.Errorf("removing broken skill symlink %s: %w", path, err)
		}
		fmt.Printf("· Removed broken skill symlink: %s\n", entry.Name())
	}
	return nil
}

// linkSkills creates symlinks from targetDir to a felt source checkout's cmd/skills/.
// This gives instant feedback when editing skills during development.
func linkSkills(targetDir, srcRoot string) error {
	skillsDir := filepath.Join(srcRoot, "cmd", "skills")
	entries, err := os.ReadDir(skillsDir)
	if err != nil {
		return fmt.Errorf("read skills from %s: %w", skillsDir, err)
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		target := filepath.Join(targetDir, name)
		src := filepath.Join(skillsDir, name)

		// Remove existing (file, dir, or symlink)
		os.RemoveAll(target)

		if err := os.Symlink(src, target); err != nil {
			return fmt.Errorf("symlink %s: %w", name, err)
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

// installSkills extracts bundled skills directly into targetDir (e.g. ~/.claude/skills).
// If update is false, existing files are not overwritten (preserves user customizations).
// If update is true, all files are overwritten with the bundled versions.
func installSkills(targetDir string, update bool) error {
	// Heal broken top-level skill symlinks left over from older `--link` installs
	// whose source has since moved or been deleted. os.MkdirAll through such a
	// symlink fails deep in the walk with a cryptic "file exists", so clean
	// felt's own dangling dev symlinks up front. Live --link symlinks (target
	// resolves) and regular dirs/files are left alone.
	if err := removeBrokenSkillSymlinks(targetDir); err != nil {
		return err
	}
	var stale []string
	err := fs.WalkDir(embeddedSkills, "skills", func(path string, d fs.DirEntry, err error) error {
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

		data, err := embeddedSkills.ReadFile(path)
		if err != nil {
			return err
		}

		// Check if file already exists
		if existing, err := os.ReadFile(target); err == nil {
			if bytes.Equal(existing, data) {
				return nil // identical, nothing to do
			}
			if !update {
				// Track which skills have updates available (any file, not just SKILL.md)
				parts := strings.SplitN(rel, string(filepath.Separator), 2)
				if len(parts) >= 1 {
					skillName := parts[0]
					found := false
					for _, s := range stale {
						if s == skillName {
							found = true
							break
						}
					}
					if !found {
						stale = append(stale, skillName)
					}
				}
				return nil // don't overwrite
			}
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

		// Report updates per top-level skill directory (deduplicated)
		parts := strings.SplitN(rel, string(filepath.Separator), 2)
		if len(parts) == 2 && parts[1] == "SKILL.md" {
			if update {
				fmt.Printf("✓ Updated skill: %s\n", parts[0])
			} else {
				fmt.Printf("✓ Installed skill: %s\n", parts[0])
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	if len(stale) > 0 {
		fmt.Printf("· Skills with updates available: %s\n", strings.Join(stale, ", "))
		fmt.Println("  Run with --update-skills to update (overwrites local changes)")
	}
	return nil
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

	// Add PreToolUse reminder hook
	if addHook(hooks, "PreToolUse", "", "felt hook remind") {
		fmt.Println("✓ Added PreToolUse hook: felt hook remind")
	} else {
		fmt.Println("· PreToolUse reminder hook already installed")
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
	if removeHook(hooks, "PreToolUse", "felt hook remind") {
		fmt.Println("✓ Removed PreToolUse reminder hook")
		removed = true
	}
	consciencePath := filepath.Join(filepath.Dir(settingsPath), "hooks", "felt-conscience.sh")
	if removeHook(hooks, "Stop", consciencePath) {
		fmt.Println("✓ Removed legacy Stop conscience hook")
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
