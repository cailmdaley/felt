package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/pelletier/go-toml/v2"
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
	Short: "Install the felt plugin for Codex via the plugin marketplace",
	Long: `Install the felt plugin for Codex.

Registers the felt plugin marketplace, enables the felt plugin in
~/.codex/config.toml, and flips features.plugin_hooks = true so Codex
runs the bundled hooks. Idempotent — re-running is safe.

By default, registers ` + marketplaceRepo + ` directly from GitHub.
Tagged felt binaries pin the plugin to the matching tag.

Wraps the official Codex CLI:

    codex plugin marketplace add ` + marketplaceRepo + `

then writes config.toml entries:

    [features]
    plugin_hooks = true

    [plugins."felt@` + marketplaceName + `"]
    enabled = true

Resolution order for --source (override the default GitHub registration):
  1. --source <path>      path to a felt repo checkout containing
                          .claude-plugin/marketplace.json
  2. $FELT_PLUGIN_DIR     env var pointing directly at the plugin directory
                          (the parent of which becomes the marketplace root)

Pre-1.0.8 felt installs used direct ~/.codex/hooks.json wiring; setup
prunes those entries on its way in.

Use --uninstall to remove.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		source, _ := cmd.Flags().GetString("source")
		uninstall, _ := cmd.Flags().GetBool("uninstall")

		if uninstall {
			return uninstallCodexPlugin()
		}

		marketplaceSource := defaultMarketplaceRef()
		if source != "" || os.Getenv("FELT_PLUGIN_DIR") != "" {
			repoRoot, err := findMarketplaceRoot(source)
			if err != nil {
				return err
			}
			marketplaceSource = repoRoot
		}

		return installCodexPluginViaCLI(marketplaceSource)
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

	// Fallback 1: a registered directory-source marketplace points straight
	// at a local repo (dev installs). Reading it out of `claude plugin
	// marketplace list --json` keeps us in sync with whatever path the user
	// registered, even if it differs from where the binary is running from.
	if entry, ok := marketplaceEntry(marketplaceName); ok && entry.Source == "directory" && entry.Path != "" {
		if hasMarketplaceManifest(entry.Path) {
			abs, err := filepath.Abs(entry.Path)
			if err == nil {
				return abs, nil
			}
		}
	}

	// Fallback 2: Claude Code clones GitHub-sourced marketplaces to a known
	// path. If the user has run `felt setup claude` (or otherwise installed
	// the marketplace from GitHub), the plugin files live there.
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
	_, ok := marketplaceEntry(name)
	return ok
}

// claudeMarketplaceEntry mirrors the structured `claude plugin marketplace
// list --json` output. Only the fields we read are decoded.
type claudeMarketplaceEntry struct {
	Name   string `json:"name"`
	Source string `json:"source"` // "directory" or "git"
	Path   string `json:"path"`   // local path for directory sources
}

// marketplaceEntry looks up an entry by name in the claude CLI's registered
// marketplaces. Returns the entry and true on success; false if the CLI is
// missing, the call fails, or the name isn't found.
func marketplaceEntry(name string) (claudeMarketplaceEntry, bool) {
	out, err := exec.Command("claude", "plugin", "marketplace", "list", "--json").Output()
	if err != nil {
		return claudeMarketplaceEntry{}, false
	}
	var entries []claudeMarketplaceEntry
	if err := json.Unmarshal(out, &entries); err != nil {
		return claudeMarketplaceEntry{}, false
	}
	for _, e := range entries {
		if e.Name == name {
			return e, true
		}
	}
	return claudeMarketplaceEntry{}, false
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

// feltCodexInstalled returns true when this machine has either the plugin
// enabled in ~/.codex/config.toml or legacy direct entries in
// ~/.codex/hooks.json from pre-1.0.8 installs. Used by `felt update` and
// the brew post-install to decide whether to refresh Codex setup alongside
// the Claude plugin — `felt setup codex` is idempotent and re-canonicalizes
// state in either case.
func feltCodexInstalled() bool {
	cfg, err := readCodexConfig()
	if err == nil {
		if plugins, ok := cfg["plugins"].(map[string]interface{}); ok {
			if _, has := plugins[codexPluginRef]; has {
				return true
			}
		}
	}
	return feltCodexLegacyHooksInstalled()
}

// feltCodexLegacyHooksInstalled returns true when ~/.codex/hooks.json has any
// felt-flagged direct entries (the pre-1.0.8 wiring). Kept around so the
// lockstep refresh path can clean those up on the next `felt update`.
func feltCodexLegacyHooksInstalled() bool {
	hooksPath, err := codexHooksPath()
	if err != nil {
		return false
	}
	data, err := os.ReadFile(hooksPath)
	if err != nil {
		return false
	}
	var settings map[string]interface{}
	if err := json.Unmarshal(data, &settings); err != nil {
		return false
	}
	hooks, ok := settings["hooks"].(map[string]interface{})
	if !ok {
		return false
	}
	for _, event := range []string{"SessionStart", "PreToolUse"} {
		for _, basename := range []string{"session.sh", "remind.sh"} {
			if hooksReferenceFelt(hooks, event, basename) {
				return true
			}
		}
	}
	return false
}

// hooksReferenceFelt walks the hook entries for an event and returns true if
// any inner command path references /hooks/<basename> (the suffix shared by
// every felt-installed Codex hook regardless of where the plugin lives).
func hooksReferenceFelt(hooks map[string]interface{}, event, basename string) bool {
	eventHooks, ok := hooks[event].([]interface{})
	if !ok {
		return false
	}
	suffix := "/hooks/" + basename
	for _, hook := range eventHooks {
		hookMap, ok := hook.(map[string]interface{})
		if !ok {
			continue
		}
		cmds, ok := hookMap["hooks"].([]interface{})
		if !ok {
			continue
		}
		for _, cmd := range cmds {
			cmdMap, ok := cmd.(map[string]interface{})
			if !ok {
				continue
			}
			cmdStr, _ := cmdMap["command"].(string)
			if strings.Contains(cmdStr, suffix) {
				return true
			}
		}
	}
	return false
}

// refreshCodexSetupIfInstalled re-runs the Codex hook wiring when felt's
// Codex setup is detected in ~/.codex/hooks.json. Used by `felt update` so
// a binary that just landed also refreshes Codex's view of the plugin
// directory. Silent no-op when Codex setup isn't installed.
func refreshCodexSetupIfInstalled() {
	if !feltCodexInstalled() {
		return
	}
	fmt.Println()
	fmt.Println("Refreshing Codex plugin...")
	if err := installCodexPluginViaCLI(defaultMarketplaceRef()); err != nil {
		fmt.Printf("Codex refresh failed: %v\n", err)
		fmt.Println("Rerun `felt setup codex` to retry.")
	}
}

func codexHooksPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("getting home directory: %w", err)
	}
	return filepath.Join(home, ".codex", "hooks.json"), nil
}

// codexPluginRef is the plugin identifier used in `~/.codex/config.toml`'s
// `[plugins."<ref>"]` block. Matches the marketplace name declared in the
// repo's marketplace.json so `claude` and `codex` see the same plugin.
const codexPluginRef = "felt@" + marketplaceName

// installCodexPluginViaCLI is the plugin-marketplace install path: register
// the marketplace via `codex plugin marketplace add`, enable the plugin and
// plugin-hooks feature in ~/.codex/config.toml, and prune any leftover
// direct-hooks.json wiring from pre-1.0.8 installs. Idempotent.
func installCodexPluginViaCLI(marketplaceSource string) error {
	if _, err := exec.LookPath("codex"); err != nil {
		return fmt.Errorf("codex CLI not found in PATH; install Codex first: %w", err)
	}

	if isCodexMarketplaceRegistered(marketplaceName) {
		// `codex plugin marketplace upgrade` only refreshes git-source
		// marketplaces; local directory sources are read live, so the only
		// state to reconcile is config.toml. Skip the redundant add call.
		fmt.Printf("· Codex marketplace already registered: %s\n", marketplaceName)
	} else {
		fmt.Printf("Adding Codex marketplace: %s\n", marketplaceSource)
		if err := runCodexCLI("plugin", "marketplace", "add", marketplaceSource); err != nil {
			return fmt.Errorf("registering codex marketplace: %w", err)
		}
	}

	enabled, err := enableCodexPlugin()
	if err != nil {
		return err
	}
	if enabled {
		fmt.Printf("✓ Enabled plugin: %s\n", codexPluginRef)
	} else {
		fmt.Printf("· Plugin already enabled: %s\n", codexPluginRef)
	}

	hooksEnabled, err := enableCodexPluginHooks()
	if err != nil {
		return err
	}
	if hooksEnabled {
		fmt.Println("✓ Enabled features.plugin_hooks in ~/.codex/config.toml")
	}

	// Pre-1.0.8 installs wrote direct entries into ~/.codex/hooks.json that
	// pointed at the plugin's session.sh / remind.sh. With plugin_hooks
	// enabled, Codex now invokes them itself; keeping the legacy entries
	// would fire the same hooks twice per session.
	if removed := pruneLegacyCodexHooks(); removed > 0 {
		fmt.Printf("✓ Removed %d legacy hooks.json entries (now served via plugin)\n", removed)
	}

	// `~/.agents/skills/{felt,ralph}` symlinks predate Codex's plugin
	// skill discovery. The plugin's `skills:` pointer in plugin.json
	// supersedes them, and leaving stale symlinks risks Codex loading
	// the same skill twice from two paths.
	if removed := pruneLegacyCodexSkills(); removed > 0 {
		fmt.Printf("✓ Removed %d legacy ~/.agents/skills symlinks (now served via plugin)\n", removed)
	}

	fmt.Println()
	fmt.Println("Restart Codex for changes to take effect.")
	return nil
}

// runCodexCLI invokes the codex CLI, piping stdio through to the caller.
func runCodexCLI(args ...string) error {
	cmd := exec.Command("codex", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// isCodexMarketplaceRegistered checks ~/.codex/config.toml for a
// `[marketplaces.<name>]` block. Codex stores registered marketplaces in
// the user config, not in a queryable CLI command, so we parse directly.
func isCodexMarketplaceRegistered(name string) bool {
	cfg, err := readCodexConfig()
	if err != nil {
		return false
	}
	markets, _ := cfg["marketplaces"].(map[string]interface{})
	_, ok := markets[name]
	return ok
}

// enableCodexPlugin writes `[plugins."felt@<marketplace>"]\nenabled = true`
// to ~/.codex/config.toml. Returns true if the value actually changed (so
// the caller can print "enabled" vs "already enabled").
func enableCodexPlugin() (bool, error) {
	return setCodexConfigBool([]string{"plugins", codexPluginRef, "enabled"}, true)
}

// enableCodexPluginHooks flips `[features].plugin_hooks = true`. Returns
// true if the value actually changed.
func enableCodexPluginHooks() (bool, error) {
	return setCodexConfigBool([]string{"features", "plugin_hooks"}, true)
}

// codexConfigPath returns ~/.codex/config.toml.
func codexConfigPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("getting home directory: %w", err)
	}
	return filepath.Join(home, ".codex", "config.toml"), nil
}

// readCodexConfig loads ~/.codex/config.toml as a generic map. Returns an
// empty map if the file doesn't exist.
func readCodexConfig() (map[string]interface{}, error) {
	path, err := codexConfigPath()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return map[string]interface{}{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	var cfg map[string]interface{}
	if err := toml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}
	if cfg == nil {
		cfg = map[string]interface{}{}
	}
	return cfg, nil
}

// writeCodexConfig serializes cfg back to ~/.codex/config.toml, creating
// parent directories as needed.
func writeCodexConfig(cfg map[string]interface{}) error {
	path, err := codexConfigPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return fmt.Errorf("creating .codex directory: %w", err)
	}
	data, err := toml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("marshaling %s: %w", path, err)
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		return fmt.Errorf("writing %s: %w", path, err)
	}
	return nil
}

// setCodexConfigBool sets a nested boolean value via a dotted path
// (e.g. ["features", "plugin_hooks"]). Creates intermediate tables as
// needed. Returns true if the value actually changed.
func setCodexConfigBool(path []string, value bool) (bool, error) {
	cfg, err := readCodexConfig()
	if err != nil {
		return false, err
	}
	cursor := cfg
	for _, key := range path[:len(path)-1] {
		next, ok := cursor[key].(map[string]interface{})
		if !ok {
			next = map[string]interface{}{}
			cursor[key] = next
		}
		cursor = next
	}
	last := path[len(path)-1]
	if existing, ok := cursor[last].(bool); ok && existing == value {
		return false, nil
	}
	cursor[last] = value
	return true, writeCodexConfig(cfg)
}

// pruneLegacyCodexHooks removes felt-flagged entries from ~/.codex/hooks.json.
// Returns the count of pruned entries.
func pruneLegacyCodexHooks() int {
	hooksPath, err := codexHooksPath()
	if err != nil {
		return 0
	}
	data, err := os.ReadFile(hooksPath)
	if err != nil {
		return 0
	}
	var settings map[string]interface{}
	if err := json.Unmarshal(data, &settings); err != nil {
		return 0
	}
	hooks, ok := settings["hooks"].(map[string]interface{})
	if !ok {
		return 0
	}
	removed := 0
	for _, event := range []string{"SessionStart", "PreToolUse"} {
		for _, basename := range []string{"session.sh", "remind.sh"} {
			pruned := pruneFeltHooks(hooks, event, basename)
			removed += len(pruned)
		}
	}
	if removed == 0 {
		return 0
	}
	out, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return 0
	}
	if err := os.WriteFile(hooksPath, out, 0644); err != nil {
		return 0
	}
	return removed
}

// pruneLegacyCodexSkills removes felt-related symlinks from
// ~/.agents/skills/. Only removes symlinks (not directories) to avoid
// touching anything the user installed manually.
func pruneLegacyCodexSkills() int {
	home, err := os.UserHomeDir()
	if err != nil {
		return 0
	}
	dir := filepath.Join(home, ".agents", "skills")
	removed := 0
	for _, skill := range []string{"felt", "ralph"} {
		target := filepath.Join(dir, skill)
		info, err := os.Lstat(target)
		if err != nil {
			continue
		}
		if info.Mode()&os.ModeSymlink == 0 {
			continue
		}
		if err := os.Remove(target); err == nil {
			removed++
		}
	}
	return removed
}

// uninstallCodexPlugin disables the plugin in config.toml, removes the
// marketplace, and prunes any leftover legacy hooks.json / agents-skills
// entries. Leaves `features.plugin_hooks` alone — other Codex plugins may
// rely on it.
func uninstallCodexPlugin() error {
	cfg, err := readCodexConfig()
	if err != nil {
		return err
	}

	changed := false
	if plugins, ok := cfg["plugins"].(map[string]interface{}); ok {
		if _, has := plugins[codexPluginRef]; has {
			delete(plugins, codexPluginRef)
			if len(plugins) == 0 {
				delete(cfg, "plugins")
			}
			changed = true
		}
	}
	if changed {
		if err := writeCodexConfig(cfg); err != nil {
			return err
		}
		fmt.Printf("✓ Disabled plugin: %s\n", codexPluginRef)
	} else {
		fmt.Printf("· Plugin not enabled: %s\n", codexPluginRef)
	}

	if _, err := exec.LookPath("codex"); err == nil && isCodexMarketplaceRegistered(marketplaceName) {
		if err := runCodexCLI("plugin", "marketplace", "remove", marketplaceName); err != nil {
			fmt.Printf("warning: could not remove marketplace %s: %v\n", marketplaceName, err)
		} else {
			fmt.Printf("✓ Removed marketplace: %s\n", marketplaceName)
		}
	}

	if removed := pruneLegacyCodexHooks(); removed > 0 {
		fmt.Printf("✓ Removed %d legacy hooks.json entries\n", removed)
	}
	if removed := pruneLegacyCodexSkills(); removed > 0 {
		fmt.Printf("✓ Removed %d legacy ~/.agents/skills symlinks\n", removed)
	}

	fmt.Println()
	fmt.Println("Restart Codex for changes to take effect.")
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
