package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

// marketplaceName is the marketplace name declared in
// <repo>/.claude-plugin/marketplace.json. Used as the suffix in
// `claude plugin install felt@<marketplaceName>`.
const marketplaceName = "cailmdaley-felt"

// marketplaceRepo is the GitHub `owner/repo` shorthand that Claude Code
// accepts in `claude plugin marketplace add`. When no --source is given,
// `felt setup claude` registers this directly so users without a local
// checkout (brew, curl install) don't have to clone anything.
const marketplaceRepo = "cailmdaley/felt"

// defaultMarketplaceRef is the GitHub ref to register when no --source is
// given. For tagged binaries we pin to the matching tag so the installed
// plugin matches the binary; `dev` builds track the default branch.
func defaultMarketplaceRef() string {
	if Version == "" || Version == "dev" {
		return marketplaceRepo
	}
	return marketplaceRepo + "#v" + Version
}

// claudeMarketplaceClonePath is the directory Claude Code clones a
// GitHub-sourced marketplace into. `felt setup codex` reads from here as
// a fallback when no --source / $FELT_PLUGIN_DIR is given, so a fresh
// install can wire up Codex hooks without a local felt checkout.
func claudeMarketplaceClonePath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".claude", "plugins", "marketplaces", marketplaceName)
}

var setupCmd = &cobra.Command{
	Use:   "setup",
	Short: "Setup integrations",
	Long:  `Setup felt integrations with external tools.`,
}

var setupClaudeCmd = &cobra.Command{
	Use:   "claude",
	Short: "Install the felt plugin for Claude Code via the plugin marketplace",
	Long: `Install the felt plugin for Claude Code.

Registers the felt plugin marketplace and installs the felt plugin from
it. The plugin bundles the felt and ralph skills plus SessionStart and
PreToolUse hooks. Idempotent — re-running is safe.

By default, registers ` + marketplaceRepo + ` directly from GitHub —
Claude Code clones the marketplace itself, so no local checkout is
required (brew or curl installs work). Tagged felt binaries pin the
plugin to the matching tag (e.g. ` + marketplaceRepo + `#v1.0.0); ` + "`dev`" + `
builds track the default branch.

Wraps the official Claude Code CLI:

    claude plugin marketplace add ` + marketplaceRepo + `[#v<tag>]
    claude plugin install felt@` + marketplaceName + `

Resolution order for --source (override the default GitHub registration):
  1. --source <path>      path to a felt repo checkout containing
                          .claude-plugin/marketplace.json
  2. $FELT_PLUGIN_DIR     env var pointing directly at the plugin directory
                          (the parent of which becomes the marketplace root)

Use --uninstall to remove.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		source, _ := cmd.Flags().GetString("source")
		uninstall, _ := cmd.Flags().GetBool("uninstall")

		if uninstall {
			return uninstallPlugin()
		}

		// No --source / $FELT_PLUGIN_DIR: register from GitHub. Claude Code
		// clones the marketplace itself.
		if source == "" && os.Getenv("FELT_PLUGIN_DIR") == "" {
			return installPluginViaCLI(defaultMarketplaceRef())
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
  3. ~/.claude/plugins/marketplaces/` + marketplaceName + `  if ` + "`felt setup claude`" + ` has run

Use --uninstall to remove.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		source, _ := cmd.Flags().GetString("source")
		uninstall, _ := cmd.Flags().GetBool("uninstall")

		// Uninstall doesn't need the plugin directory — we identify felt
		// hooks by their `/hooks/<basename>` path suffix in hooks.json, so
		// stale entries get pruned even if the original source is gone.
		if uninstall {
			return uninstallCodexHooks()
		}

		pluginDir, pluginErr := findPluginDir(source)
		if pluginErr != nil {
			return pluginErr
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
  3. ~/.claude/plugins/marketplaces/` + marketplaceName + `  if ` + "`felt setup claude`" + ` has run`,
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
// Resolution order: explicit --source arg, $FELT_PLUGIN_DIR, then the
// already-installed Claude Code marketplace clone at
// ~/.claude/plugins/marketplaces/<marketplaceName>/ (so `felt setup codex`
// works after `felt setup claude` without a separate local checkout).
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

	// Fallback: Claude Code clones GitHub-sourced marketplaces to a known
	// path. If the user has run `felt setup claude` (or otherwise installed
	// the marketplace), the plugin files live there.
	if cloned := claudeMarketplaceClonePath(); cloned != "" && hasMarketplaceManifest(cloned) {
		abs, err := filepath.Abs(cloned)
		if err == nil {
			return abs, nil
		}
	}

	return "", fmt.Errorf("could not find felt plugin source\n" +
		"  Run `felt setup claude` first (clones the marketplace from GitHub),\n" +
		"  or pass --source <checkout> for local development,\n" +
		"  or set $FELT_PLUGIN_DIR pointing at <repo>/claude-plugin/")
}

// installPluginViaCLI installs or refreshes the felt plugin. If the
// marketplace is already registered, runs `marketplace update` + `plugin
// update` to pull the latest content and apply it; otherwise registers the
// marketplace fresh and installs the plugin. This is the path that keeps the
// installed plugin in lockstep with the running binary — invoked from
// `felt setup claude`, from `felt update` after the binary swap, and from the
// homebrew formula's post-install. Idempotent.
func installPluginViaCLI(repoRoot string) error {
	if _, err := exec.LookPath("claude"); err != nil {
		return fmt.Errorf("claude CLI not found in PATH; install Claude Code first: %w", err)
	}

	pluginRef := "felt@" + marketplaceName

	if isMarketplaceRegistered(marketplaceName) {
		if err := runClaudeCLI("plugin", "marketplace", "update", marketplaceName); err != nil {
			return fmt.Errorf("refreshing marketplace: %w", err)
		}
		if err := runClaudeCLI("plugin", "update", pluginRef); err != nil {
			return fmt.Errorf("updating %s: %w", pluginRef, err)
		}
		fmt.Println()
		fmt.Println("Restart Claude Code for changes to take effect.")
		return nil
	}

	if err := runClaudeCLI("plugin", "marketplace", "add", repoRoot); err != nil {
		return fmt.Errorf("registering marketplace: %w", err)
	}
	if err := runClaudeCLI("plugin", "install", pluginRef); err != nil {
		return fmt.Errorf("installing %s: %w", pluginRef, err)
	}

	fmt.Println()
	fmt.Println("Restart Claude Code for changes to take effect.")
	return nil
}

// isMarketplaceRegistered returns true if the given marketplace name appears
// in `claude plugin marketplace list` output. Used to choose between the
// add+install and update+update paths in installPluginViaCLI.
func isMarketplaceRegistered(name string) bool {
	out, err := exec.Command("claude", "plugin", "marketplace", "list").Output()
	if err != nil {
		return false
	}
	// `claude plugin marketplace list` formats each entry as a leading `❯ <name>`
	// line. A bare substring match risks matching unrelated text (a description
	// containing the name); anchoring to the marker is robust enough without
	// parsing the full output structure.
	return strings.Contains(string(out), "❯ "+name+"\n")
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
		"Containment comes from directories, narrative connections come from `[[wikilinks]]`, and non-native frontmatter is preserved opaquely for downstream tools. " +
		"`.felt/` also opens as a valid Obsidian vault, with Dataview queries over frontmatter fields. " +
		"Filing costs nothing; forgetting costs an investigation or a hallucination.\n\n" +
		"**Rhythm.** File as things come into focus, without asking. After you respond, while the user reads, update the fiber or its frontmatter directly. Close with an outcome that stands alone.\n" +
		fence + "bash\n" +
		"felt add covariance-method \"Covariance method\"          # came into focus\n" +
		"felt edit covariance-method -s active                    # entered tracking\n" +
		"felt edit covariance-method -o \"Jackknife is stable\"   # closed with outcome\n" +
		fence + "\n\n" +
		"**Discipline.** Names are short, concrete handles for the concern. " +
		"Path IDs like `bao-analysis/damping-prior` are first-class; bare slugs resolve only when unambiguous. " +
		"Outcomes say not just *what* but *why*. " +
		"If a project uses extra frontmatter conventions, edit the file directly and let that project own the schema. " +
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

	// Prune any existing felt hooks first. The plugin source path can change
	// between runs (different --source, different felt versions, GitHub clone
	// vs local checkout), and addHook only dedupes by exact string match.
	// Path-suffix pruning makes setup truly idempotent regardless of source.
	prevSession := pruneFeltHooks(hooks, "SessionStart", "session.sh")
	prevRemind := pruneFeltHooks(hooks, "PreToolUse", "remind.sh")

	addHook(hooks, "SessionStart", "", sessionCmd)
	addHook(hooks, "PreToolUse", "", remindCmd)

	reportHookChange("SessionStart", prevSession, sessionCmd)
	reportHookChange("PreToolUse", prevRemind, remindCmd)

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

func uninstallCodexHooks() error {
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

	// Match by path suffix (./hooks/<basename>) so uninstall works even when
	// the original install pointed at a different path — including when the
	// felt checkout that installed it has been deleted, which is exactly the
	// scenario where pluginDir-based exact-match uninstall used to fail.
	prunedSession := pruneFeltHooks(hooks, "SessionStart", "session.sh")
	prunedRemind := pruneFeltHooks(hooks, "PreToolUse", "remind.sh")
	if len(prunedSession) > 0 {
		fmt.Printf("✓ Removed %d SessionStart hook(s)\n", len(prunedSession))
	}
	if len(prunedRemind) > 0 {
		fmt.Printf("✓ Removed %d PreToolUse hook(s)\n", len(prunedRemind))
	}
	if len(prunedSession)+len(prunedRemind) == 0 {
		fmt.Println("No felt Codex hooks found")
		return nil
	}

	data, err = json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling hooks.json: %w", err)
	}
	if err := os.WriteFile(hooksPath, data, 0644); err != nil {
		return fmt.Errorf("writing hooks.json: %w", err)
	}
	fmt.Printf("Hooks: %s\n", hooksPath)
	return nil
}

// reportHookChange prints a one-line summary of a hook install based on what
// was there before (`prev`) vs the desired command (`current`):
//
//   - prev empty                                → "✓ Added"
//   - prev = [current]                          → "· already installed"
//   - prev contains current + extras            → "✓ Removed N duplicate(s)"
//   - prev exists, current not in it (path moved) → "✓ Updated"
//   - prev exists, multiple distinct stale paths → "✓ Updated (was: ...)"
func reportHookChange(event string, prev []string, current string) {
	hadCurrent := false
	var stale []string
	for _, c := range prev {
		if c == current {
			hadCurrent = true
		} else {
			stale = append(stale, c)
		}
	}

	switch {
	case len(prev) == 0:
		fmt.Printf("✓ Added %s hook: %s\n", event, current)
	case hadCurrent && len(stale) == 0 && len(prev) == 1:
		fmt.Printf("· %s hook already installed\n", event)
	case hadCurrent && len(stale) == 0:
		fmt.Printf("✓ Removed %d duplicate %s hook(s)\n", len(prev)-1, event)
	case hadCurrent:
		fmt.Printf("✓ Updated %s hook: removed %d stale, kept %s\n", event, len(stale), current)
	default:
		fmt.Printf("✓ Updated %s hook: %s (was: %s)\n", event, current, strings.Join(stale, ", "))
	}
}

// pruneFeltHooks removes any hook entries under `event` whose inner command
// references the felt plugin's hook script for the given basename (e.g.
// "session.sh"). Matches on the path suffix `<plugin>/hooks/<basename>` so
// stale hooks from prior installs at different paths are caught regardless of
// where the plugin lived. Returns the command strings that were removed, so
// callers can tell "already installed" from "updated" when the same path is
// being re-added.
func pruneFeltHooks(hooks map[string]interface{}, event, basename string) []string {
	eventHooks, ok := hooks[event].([]interface{})
	if !ok {
		return nil
	}

	suffix := "/hooks/" + basename
	var removed []string
	filtered := make([]interface{}, 0, len(eventHooks))

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
		// Drop the entire hook entry if any of its inner commands looks like
		// a felt hook. Codex hook entries always carry exactly one command in
		// our installs; this is conservative for hand-edited configs too —
		// if you've co-located another script under the same entry we'll
		// take it with the felt one, which is unlikely in practice.
		var feltCmd string
		for _, cmd := range cmds {
			cmdMap, ok := cmd.(map[string]interface{})
			if !ok {
				continue
			}
			cmdStr, _ := cmdMap["command"].(string)
			if strings.Contains(cmdStr, suffix) {
				feltCmd = cmdStr
				break
			}
		}
		if feltCmd != "" {
			removed = append(removed, feltCmd)
			continue
		}
		filtered = append(filtered, hook)
	}

	if len(filtered) == 0 {
		delete(hooks, event)
	} else {
		hooks[event] = filtered
	}
	return removed
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
