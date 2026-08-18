package cmd

import (
	"encoding/json"
	"errors"
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
// GitHub-sourced marketplace into. `felt setup skills` reads from here as a
// fallback when no --source / $FELT_PLUGIN_DIR is given, so linking skills
// works after `felt setup claude` without a local checkout.
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
it. The plugin bundles the felt skill plus four hooks: SessionStart and
PreToolUse surface active fibers and gate non-felt tool use, PostToolUse
stamps updated-at on a directly edited fiber, and an activity-event hook
records harness events for shuttle (writing nothing unless ~/.shuttle
exists). Idempotent — re-running is safe.

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

Registers the felt plugin marketplace and installs the felt plugin from
it. The plugin bundles the felt and shuttle skills plus the hooks that
surface active fibers and record harness activity for shuttle.
Idempotent — re-running is safe.

By default, registers ` + marketplaceRepo + ` directly from GitHub.
Tagged felt binaries pin the plugin to the matching tag.

Wraps the official Codex CLI (Codex's @ref syntax — Claude uses #ref):

    codex plugin marketplace add ` + marketplaceRepo + `[@v<tag>]
    codex plugin add felt@` + marketplaceName + `

Codex reviews a plugin's hooks before running them: your next interactive
Codex session will ask you to trust felt's, and until you accept, the
skills load but the hooks stay dormant.

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

		if err := installCodexPluginViaCLI(marketplaceSource); err != nil {
			return err
		}

		// Codex doesn't have CLAUDE.md's "skill discovery via plugin" convention
		// turned on for every user yet, and the AGENTS.md snippet is a nice
		// nudge toward the practice on top of having the skill loadable.
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
	Long: `Link felt skills from the plugin directory into a target directory.

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
	setupCodexCmd.Flags().Bool("uninstall", false, "Remove felt plugin from Codex")
	setupCodexCmd.Flags().String("source", "", "Path to felt repo checkout or plugin directory")
	setupSkillsCmd.Flags().String("target", "", "Target directory (default: ~/.claude/skills)")
	setupSkillsCmd.Flags().String("source", "", "Path to felt repo checkout or plugin directory")
	setupCmd.AddCommand(setupClaudeCmd)
	setupCmd.AddCommand(setupCodexCmd)
	setupCmd.AddCommand(setupSkillsCmd)
	rootCmd.AddCommand(setupCmd)
}

// hasMarketplaceManifest returns true if dir contains a marketplace manifest at
// .claude-plugin/marketplace.json (the standard marketplace layout).
func hasMarketplaceManifest(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, ".claude-plugin", "marketplace.json"))
	return err == nil
}

// findPluginDir returns the plugin directory derived from the marketplace
// root: <repo-root>/claude-plugin/. Used by `setup skills`, which reads the
// skill directories out of it.
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
// ~/.claude/plugins/marketplaces/<marketplaceName>/ (so `felt setup skills`
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

// installPluginViaCLI installs or refreshes the felt plugin. Always
// `marketplace add`s with the caller's `repoRoot` — for git sources that
// advances the pinned ref to whatever the current binary's
// defaultMarketplaceRef() emits, and for directory sources it's a no-op
// re-register. Then plugin install (fresh) or plugin update (existing) to
// apply. Idempotent.
//
// The marketplace-ref-advance is the critical bit: `marketplace update` on
// a pinned git source just re-fetches the SAME ref, so on a brew-upgrade
// from v1.0.7 → v1.0.8, an installed plugin pinned at v1.0.7 would never
// see new content. `marketplace add` with the new ref is what actually
// moves the user forward.
func installPluginViaCLI(repoRoot string) error {
	if _, err := exec.LookPath("claude"); err != nil {
		return fmt.Errorf("claude CLI not found in PATH; install Claude Code first: %w", err)
	}

	pluginRef := "felt@" + marketplaceName
	// Ask whether the PLUGIN is installed, not whether its marketplace is
	// registered: `felt setup claude --uninstall` leaves the marketplace
	// behind on purpose, so a marketplace-based check sends the next setup
	// down the update path for a plugin that isn't there — and `claude
	// plugin update` hard-fails on a missing plugin.
	installed := isPluginInstalled(pluginRef)

	if err := runClaudeCLI("plugin", "marketplace", "add", repoRoot); err != nil {
		return fmt.Errorf("registering marketplace: %w", err)
	}

	op, gerund := "install", "installing"
	if installed {
		op, gerund = "update", "updating"
	}
	if err := runClaudeCLI("plugin", op, pluginRef); err != nil {
		return fmt.Errorf("%s %s: %w", gerund, pluginRef, err)
	}

	fmt.Println()
	fmt.Println("Restart Claude Code for changes to take effect.")
	return nil
}

// isMarketplaceRegistered returns true if the given marketplace name appears
// in `claude plugin marketplace list` output.
func isMarketplaceRegistered(name string) bool {
	_, ok := marketplaceEntry(name)
	return ok
}

// claudePluginEntry mirrors the structured `claude plugin list --json`
// output. Only the fields we read are decoded.
type claudePluginEntry struct {
	ID string `json:"id"` // "<plugin>@<marketplace>"
}

// isPluginInstalled reports whether `claude plugin list` knows the given
// "<plugin>@<marketplace>" ref. Chooses between the install and update paths
// in installPluginViaCLI. Returns false when the CLI is missing or the call
// fails — install is the safe guess, since installing an installed plugin is
// a no-op while updating a missing one is an error.
func isPluginInstalled(ref string) bool {
	out, err := exec.Command("claude", "plugin", "list", "--json").Output()
	if err != nil {
		return false
	}
	var entries []claudePluginEntry
	if err := json.Unmarshal(out, &entries); err != nil {
		return false
	}
	for _, e := range entries {
		if e.ID == ref {
			return true
		}
	}
	return false
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

// feltCodexInstalled returns true when the felt plugin is installed for Codex:
// the plugin entry in ~/.codex/config.toml, or legacy direct entries in
// ~/.codex/hooks.json. Used by `felt update` and the brew post-install to
// decide whether to refresh Codex setup alongside the Claude plugin, so it
// deliberately does not count a bare marketplace registration — reinstalling a
// plugin the user removed is worse than leaving a stray registration.
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

// feltCodexWiringPresent returns true when anything felt put in Codex's config
// is still there — the installed plugin, or felt's marketplace registration on
// its own. Used by `felt uninstall`, which asks "is there anything of ours to
// remove?" rather than "is the plugin installed?".
//
// The two questions need different answers because their config states are
// identical. A registration without a plugin is either an install that failed
// between the two verbs or a user who ran `codex plugin remove`, which leaves
// the marketplace behind. Uninstall should clean up either; refresh must not
// reinstall the second one, so it keeps the narrower test above.
func feltCodexWiringPresent() bool {
	if feltCodexInstalled() {
		return true
	}
	cfg, err := readCodexConfig()
	if err != nil {
		return false
	}
	markets, ok := cfg["marketplaces"].(map[string]interface{})
	if !ok {
		return false
	}
	_, has := markets[marketplaceName]
	return has
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

// refreshCodexSetupIfInstalled reinstalls the Codex plugin from marketplaceRef
// when felt's Codex setup is detected — the plugin enabled in
// ~/.codex/config.toml, or a legacy hooks.json from an install that predates
// the plugin. Used by `felt update` so the plugin follows the binary. Takes the
// ref rather than deriving one, so an update from a local checkout keeps Codex
// on that checkout instead of quietly repointing it at GitHub. Silent no-op
// when Codex setup isn't installed.
func refreshCodexSetupIfInstalled(marketplaceRef string) {
	if !feltCodexInstalled() {
		return
	}
	fmt.Println()
	fmt.Println("Refreshing Codex plugin...")
	if err := installCodexPluginViaCLI(marketplaceRef); err != nil {
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

// codexMarketplaceSource adapts a Claude-flavored marketplace ref
// (`owner/repo#tag`) into Codex's accepted form (`owner/repo@tag`). Local
// filesystem paths are passed through unchanged. The two CLIs diverged on
// ref syntax; defaultMarketplaceRef() produces Claude's form for ergonomic
// reuse, so we translate at the boundary instead of carrying two refs.
func codexMarketplaceSource(source string) string {
	if isLocalPath(source) {
		return source
	}
	if i := strings.LastIndex(source, "#"); i >= 0 {
		return source[:i] + "@" + source[i+1:]
	}
	return source
}

// isLocalPath reports whether source names a local filesystem path
// (absolute, relative, or home-anchored) rather than a git/GitHub ref.
func isLocalPath(source string) bool {
	return strings.HasPrefix(source, "/") ||
		strings.HasPrefix(source, ".") ||
		strings.HasPrefix(source, "~")
}

// installCodexPluginViaCLI points the marketplace at `marketplaceSource`, then
// installs the plugin with `codex plugin add` — which materializes the plugin
// cache under ~/.codex/plugins/cache/ and writes the
// `[plugins."felt@…"] enabled = true` entry itself, so felt never touches
// ~/.codex/config.toml. Both verbs are idempotent; re-running is safe.
func installCodexPluginViaCLI(marketplaceSource string) error {
	if _, err := exec.LookPath("codex"); err != nil {
		return fmt.Errorf("codex CLI not found in PATH; install Codex first: %w", err)
	}

	if err := repointCodexMarketplace(codexMarketplaceSource(marketplaceSource)); err != nil {
		return err
	}

	if err := runCodexCLI("plugin", "add", codexPluginRef); err != nil {
		return fmt.Errorf("installing %s: %w\n"+
			"  felt installs through Codex's native plugin commands, verified on\n"+
			"  codex-cli 0.147.0. Upgrade Codex if `codex plugin add` is unknown.",
			codexPluginRef, err)
	}

	// Direct ~/.codex/hooks.json entries would fire the same hooks a second
	// time alongside the plugin's.
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
	fmt.Println("Restart Codex for changes to take effect. Your next interactive Codex")
	fmt.Println("session will ask you to review and trust felt's hooks — until you accept,")
	fmt.Println("the skills load but the hooks stay dormant.")
	return nil
}

// repointCodexMarketplace registers codexSource under felt's marketplace name.
// Codex binds a marketplace name to exactly one source, so adding the same name
// at a different ref — what a binary upgrade needs — fails until the old
// registration is dropped.
//
// Dropping it is only ever done in response to that specific refusal. Every
// other failure — no network, a tag that isn't published yet, a codex too old
// for the verb — returns with the existing registration untouched, because
// unregistering felt on the way to failing to register it is strictly worse
// than doing nothing.
func repointCodexMarketplace(codexSource string) error {
	out, err := runCodexCLIQuiet("plugin", "marketplace", "add", codexSource)
	if err == nil {
		fmt.Print(out)
		return nil
	}
	if !codexMarketplaceConflict(out) {
		return fmt.Errorf("registering codex marketplace %s: %w\n%s", codexSource, err, strings.TrimSpace(out))
	}

	fmt.Printf("Repointing marketplace %s → %s\n", marketplaceName, codexSource)
	if _, rmErr := runCodexCLIQuiet("plugin", "marketplace", "remove", marketplaceName); rmErr != nil {
		return fmt.Errorf("repointing codex marketplace %s: %w\n%s", codexSource, err, strings.TrimSpace(out))
	}

	retryOut, retryErr := runCodexCLIQuiet("plugin", "marketplace", "add", codexSource)
	if retryErr != nil {
		return fmt.Errorf("re-registering codex marketplace %s: %w\n%s\n"+
			"  The previous registration was removed to repoint it; rerun\n"+
			"  `felt setup codex` once the cause is fixed.",
			codexSource, retryErr, strings.TrimSpace(retryOut))
	}
	fmt.Print(retryOut)
	return nil
}

// codexMarketplaceConflict reports whether codex refused an add because
// *felt's* marketplace name is already bound to a different source — the one
// failure repointing fixes. The name matters: codex names the colliding
// marketplace, and a collision on someone else's is not licence to unregister
// ours. Matching on codex's message is a soft dependency, and it fails in the
// safe direction: if the wording changes, a repoint that would have worked
// surfaces as an error instead of silently unregistering the marketplace.
func codexMarketplaceConflict(out string) bool {
	return strings.Contains(out, "marketplace '"+marketplaceName+"' is already added from a different source")
}

// runCodexCLI invokes the codex CLI, piping stdio through to the caller.
func runCodexCLI(args ...string) error {
	cmd := exec.Command("codex", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// runCodexCLIQuiet invokes the codex CLI capturing combined output instead of
// streaming it, so a failure the caller recovers from doesn't print an alarming
// error the user can't act on.
func runCodexCLIQuiet(args ...string) (string, error) {
	out, err := exec.Command("codex", args...).CombinedOutput()
	return string(out), err
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

// reportCodexRemoval echoes what codex said about a removal and reports whether
// it actually failed. Nothing-to-remove is the end state uninstall wanted, so it
// prints as a note; anything else is returned, because a removal that didn't
// happen must not be announced as one. `codex plugin remove` exits 0 on an
// absent plugin, so only `marketplace remove` reaches the benign branch.
func reportCodexRemoval(out string, err error) error {
	text := strings.TrimSpace(out)
	message := strings.TrimPrefix(text, "Error: ")
	if err == nil {
		if text != "" {
			fmt.Println(text)
		}
		return nil
	}
	if strings.Contains(text, "is not configured or installed") {
		if message != "" {
			fmt.Printf("· %s\n", message)
		}
		return nil
	}
	if message == "" {
		return err
	}
	return fmt.Errorf("%s", message)
}

// uninstallCodexPlugin removes the plugin and its marketplace through Codex's
// own commands, then prunes any leftover hooks.json / agents-skills entries.
func uninstallCodexPlugin() error {
	var failures []error
	if _, err := exec.LookPath("codex"); err == nil {
		// `plugin remove` drops both the config.toml entry and the cached
		// plugin directory; `marketplace remove` unregisters the source.
		// A failure here doesn't stop the legacy pruning below, but it is
		// carried to the end so uninstall doesn't claim to have finished.
		if err := reportCodexRemoval(runCodexCLIQuiet("plugin", "remove", codexPluginRef)); err != nil {
			failures = append(failures, fmt.Errorf("removing plugin %s: %w", codexPluginRef, err))
		}
		if err := reportCodexRemoval(runCodexCLIQuiet("plugin", "marketplace", "remove", marketplaceName)); err != nil {
			failures = append(failures, fmt.Errorf("removing marketplace %s: %w", marketplaceName, err))
		}
	} else {
		fmt.Println("codex CLI not found in PATH — skipping plugin removal.")
		fmt.Println("Rerun `felt setup codex --uninstall` with codex installed to finish.")
	}

	if removed := pruneLegacyCodexHooks(); removed > 0 {
		fmt.Printf("✓ Removed %d legacy hooks.json entries\n", removed)
	}
	if removed := pruneLegacyCodexSkills(); removed > 0 {
		fmt.Printf("✓ Removed %d legacy ~/.agents/skills symlinks\n", removed)
	}

	if len(failures) > 0 {
		return errors.Join(failures...)
	}

	fmt.Println()
	fmt.Println("Restart Codex for changes to take effect.")
	return nil
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
