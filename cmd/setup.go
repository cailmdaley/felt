package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/spf13/cobra"
)

// marketplaceName is the marketplace name declared in
// <repo>/.claude-plugin/marketplace.json. Used as the suffix in
// `claude plugin install felt@<marketplaceName>`.
const marketplaceName = "cailmdaley-felt"

var setupCmd = &cobra.Command{
	Use:   "setup",
	Short: "Setup integrations",
	Long:  `Setup felt integrations with external tools.`,
}

var setupClaudeCmd = &cobra.Command{
	Use:   "claude",
	Short: "Install the felt plugin for Claude Code via the plugin marketplace",
	Long: `Install the felt plugin for Claude Code.

Registers the felt repository as a Claude Code plugin marketplace and
installs the felt plugin from it. The plugin bundles the felt and ralph
skills plus SessionStart and PreToolUse hooks. Idempotent — re-running
is safe.

Wraps the official Claude Code CLI:

    claude plugin marketplace add <repo>
    claude plugin install felt@` + marketplaceName + `

Resolution order for --source (which repo to register):
  1. --source <path>      path to a felt repo checkout containing
                          .claude-plugin/marketplace.json
  2. $FELT_PLUGIN_DIR     env var pointing directly at the plugin directory
                          (the parent of which becomes the marketplace root)
  3. ~/.claude/plugins/felt@` + marketplaceName + `  already-installed (idempotent re-install)

Use --uninstall to remove.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		source, _ := cmd.Flags().GetString("source")
		uninstall, _ := cmd.Flags().GetBool("uninstall")

		if uninstall {
			return uninstallPlugin()
		}

		repoRoot, err := findMarketplaceRoot(source)
		if err != nil {
			return err
		}

		return installPluginViaCLI(repoRoot)
	},
}

var setupCodexCmd = &cobra.Command{
	Use:   "codex",
	Short: "Setup Codex integration",
	Long: `Install felt hooks and skills for Codex.

Symlinks the felt and ralph skills from the plugin directory into
~/.agents/skills/, and configures Codex's hooks.json to point at the
plugin's hook scripts (session.sh, remind.sh) via the symlink at
~/.agents/skills/felt/../hooks/. Codex doesn't have a plugin manifest
of its own, so we shell out to the same scripts the plugin uses.

Resolution order for --source:
  1. --source <path>      path to a felt repo checkout or plugin directory
  2. $FELT_PLUGIN_DIR     env var pointing at the plugin directory
  3. ~/.claude/plugins/felt  if the plugin is installed for Claude Code

Use --uninstall to remove.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		source, _ := cmd.Flags().GetString("source")
		uninstall, _ := cmd.Flags().GetBool("uninstall")

		pluginDir, pluginErr := findPluginDir(source)

		if uninstall {
			return uninstallCodexHooks(pluginDir)
		}

		if pluginErr != nil {
			return fmt.Errorf("plugin directory required to install Codex hooks: %w\n  Install the plugin first with: felt setup claude --source <path>", pluginErr)
		}

		if err := installCodexHooks(pluginDir); err != nil {
			return err
		}

		skillsTarget := filepath.Join(os.Getenv("HOME"), ".agents", "skills")
		if err := linkSkillsFromPlugin(skillsTarget, pluginDir); err != nil {
			fmt.Printf("warning: could not link skills: %v\n", err)
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

// hasMarketplaceManifest returns true if dir contains a marketplace manifest at
// .claude-plugin/marketplace.json (the standard marketplace layout).
func hasMarketplaceManifest(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, ".claude-plugin", "marketplace.json"))
	return err == nil
}

// findPluginDir returns the plugin directory derived from the marketplace
// root: <repo-root>/claude-plugin/. Used by `setup codex` and `setup skills`,
// which need to read skill directories or pass absolute paths to Codex hook
// configuration.
func findPluginDir(source string) (string, error) {
	root, err := findMarketplaceRoot(source)
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "claude-plugin"), nil
}

// findMarketplaceRoot resolves the directory to register as a Claude Code
// plugin marketplace. The directory must contain
// .claude-plugin/marketplace.json (the felt repo root, by convention).
//
// Resolution order: explicit source arg, $FELT_PLUGIN_DIR, then derive from
// the installed plugin's symlinked path.
func findMarketplaceRoot(source string) (string, error) {
	if source != "" {
		if hasMarketplaceManifest(source) {
			abs, err := filepath.Abs(source)
			if err != nil {
				return "", err
			}
			return abs, nil
		}
		// Allow pointing at the plugin subdir; walk one level up to find
		// the marketplace root.
		parent := filepath.Dir(source)
		if hasMarketplaceManifest(parent) {
			abs, err := filepath.Abs(parent)
			if err != nil {
				return "", err
			}
			return abs, nil
		}
		return "", fmt.Errorf("no marketplace manifest found at %q\n  Expected .claude-plugin/marketplace.json (felt repo root)", source)
	}

	if env := os.Getenv("FELT_PLUGIN_DIR"); env != "" {
		// $FELT_PLUGIN_DIR points at the plugin dir; the repo root is its parent.
		root := filepath.Dir(env)
		if hasMarketplaceManifest(root) {
			abs, err := filepath.Abs(root)
			if err != nil {
				return "", err
			}
			return abs, nil
		}
		return "", fmt.Errorf("$FELT_PLUGIN_DIR=%q: parent has no .claude-plugin/marketplace.json", env)
	}

	return "", fmt.Errorf("could not find felt repo root\n" +
		"  Pass --source <checkout> (e.g. felt setup claude --source ~/src/felt)\n" +
		"  or set $FELT_PLUGIN_DIR pointing at <repo>/claude-plugin/")
}

// installPluginViaCLI registers the marketplace and installs the plugin via
// the Claude Code CLI (`claude plugin marketplace add` and `claude plugin
// install`). Both commands are idempotent — re-running is safe.
func installPluginViaCLI(repoRoot string) error {
	if _, err := exec.LookPath("claude"); err != nil {
		return fmt.Errorf("claude CLI not found in PATH; install Claude Code first: %w", err)
	}

	if err := runClaudeCLI("plugin", "marketplace", "add", repoRoot); err != nil {
		return fmt.Errorf("registering marketplace: %w", err)
	}

	pluginRef := "felt@" + marketplaceName
	if err := runClaudeCLI("plugin", "install", pluginRef); err != nil {
		return fmt.Errorf("installing %s: %w", pluginRef, err)
	}

	fmt.Println()
	fmt.Println("Restart Claude Code for changes to take effect.")
	return nil
}

// uninstallPlugin removes the felt plugin via the Claude Code CLI. Leaves
// the marketplace registered (cheap to keep; harmless if never used again).
func uninstallPlugin() error {
	if _, err := exec.LookPath("claude"); err != nil {
		return fmt.Errorf("claude CLI not found in PATH: %w", err)
	}

	pluginRef := "felt@" + marketplaceName
	if err := runClaudeCLI("plugin", "uninstall", pluginRef); err != nil {
		return fmt.Errorf("uninstalling %s: %w", pluginRef, err)
	}

	fmt.Println()
	fmt.Println("Restart Claude Code for changes to take effect.")
	return nil
}

// runClaudeCLI invokes the claude CLI, piping stdout/stderr through to the
// caller so the user sees the same status output Claude Code prints natively.
func runClaudeCLI(args ...string) error {
	cmd := exec.Command("claude", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
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

// codexHookCommands returns the (sessionCmd, remindCmd) bash invocations Codex
// should use, pointed at the plugin's hook scripts via absolute paths. The
// scripts are part of the plugin install (claude-plugin/hooks/*.sh) and stay
// in lockstep with the plugin's hooks.json bindings.
func codexHookCommands(pluginDir string) (string, string) {
	abs, _ := filepath.Abs(pluginDir)
	session := fmt.Sprintf("%q", filepath.Join(abs, "hooks", "session.sh"))
	remind := fmt.Sprintf("%q", filepath.Join(abs, "hooks", "remind.sh"))
	return session, remind
}

func installCodexHooks(pluginDir string) error {
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

	sessionCmd, remindCmd := codexHookCommands(pluginDir)

	if addHook(hooks, "SessionStart", "", sessionCmd) {
		fmt.Printf("✓ Added SessionStart hook: %s\n", sessionCmd)
	} else {
		fmt.Println("· SessionStart hook already installed")
	}

	if addHook(hooks, "PreToolUse", "", remindCmd) {
		fmt.Printf("✓ Added PreToolUse hook: %s\n", remindCmd)
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

	fmt.Println()
	fmt.Printf("Hooks: %s\n", hooksPath)
	fmt.Println("If native hooks are still disabled, run: codex features enable codex_hooks")
	return nil
}

func uninstallCodexHooks(pluginDir string) error {
	hooksPath, err := codexHooksPath()
	if err != nil {
		return err
	}

	data, err := os.ReadFile(hooksPath)
	if err != nil {
		fmt.Println("No Codex hooks.json found")
		return nil
	}

	var settings map[string]interface{}
	if err := json.Unmarshal(data, &settings); err != nil {
		return fmt.Errorf("parsing hooks.json: %w", err)
	}

	hooks, ok := settings["hooks"].(map[string]interface{})
	if !ok {
		fmt.Println("No hooks found")
		return nil
	}

	if pluginDir == "" {
		return fmt.Errorf("uninstall requires the plugin directory to know which scripts to remove\n  Pass --source <checkout> or set $FELT_PLUGIN_DIR")
	}

	sessionCmd, remindCmd := codexHookCommands(pluginDir)
	removed := false
	if removeHook(hooks, "SessionStart", sessionCmd) {
		fmt.Println("✓ Removed SessionStart hook")
		removed = true
	}
	if removeHook(hooks, "PreToolUse", remindCmd) {
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

