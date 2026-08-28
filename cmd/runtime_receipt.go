package cmd

// The setup receipt is deliberately narrower than a general "doctor": it is
// the install boundary's proof that the executable, the bundle which a
// harness enabled, its hooks, and the daemon contract belong to one usable
// runtime.  It reads the same files and endpoint as setup/hooks/version; it
// does not maintain a second installation database.

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

type receiptStatus string

const (
	receiptHealthy  receiptStatus = "healthy"
	receiptMissing  receiptStatus = "missing"
	receiptStale    receiptStatus = "stale"
	receiptMismatch receiptStatus = "mismatch"
	receiptPartial  receiptStatus = "partial"
)

// RuntimeReceipt is intentionally compact and stable enough for installers to
// consume.  Paths are included as evidence: a version without the path cannot
// distinguish the active cache from a source checkout which merely happens to
// contain a matching manifest.
type RuntimeReceipt struct {
	Schema     int                      `json:"schema"`
	Status     receiptStatus            `json:"status"`
	Repair     string                   `json:"repair,omitempty"`
	Felt       ReceiptComponent         `json:"felt"`
	Bundles    []ReceiptBundle          `json:"bundles"`
	Hooks      ReceiptComponent         `json:"hooks"`
	Daemon     ReceiptDaemon            `json:"daemon"`
	Generation ReceiptGenerationReceipt `json:"generation"`
}

type ReceiptComponent struct {
	Status  receiptStatus `json:"status"`
	Repair  string        `json:"repair,omitempty"`
	Path    string        `json:"path,omitempty"`
	Version string        `json:"version,omitempty"`
}

type ReceiptBundle struct {
	Harness  string        `json:"harness"`
	Source   string        `json:"source,omitempty"`
	Path     string        `json:"path,omitempty"`
	Version  string        `json:"version,omitempty"`
	Enabled  bool          `json:"enabled"`
	Evidence string        `json:"evidence,omitempty"`
	Status   receiptStatus `json:"status"`
	Repair   string        `json:"repair,omitempty"`
}

type ReceiptDaemon struct {
	URL      string        `json:"url"`
	Status   receiptStatus `json:"status"`
	Repair   string        `json:"repair,omitempty"`
	Expected any           `json:"expected,omitempty"`
	Observed any           `json:"observed,omitempty"`
	CLI      any           `json:"cli_observed,omitempty"`
	Contract bool          `json:"contract_ok"`
}

// ReceiptGenerationReceipt is the receipt-side view of the promoted source
// and the copies which the native harnesses report as loaded.  The marker is
// deliberately read-only here: plugin_generation.go owns writing it during
// promotion.  Keeping the check in the receipt means a cache path is never
// treated as healthy merely because its manifest version happens to match.
type ReceiptGenerationReceipt struct {
	Status     receiptStatus              `json:"status"`
	Repair     string                     `json:"repair,omitempty"`
	ActivePath string                     `json:"active_path,omitempty"`
	Active     *pluginGenerationIdentity  `json:"active,omitempty"`
	Harnesses  []ReceiptHarnessGeneration `json:"harnesses,omitempty"`
}

type ReceiptHarnessGeneration struct {
	Harness    string                    `json:"harness"`
	Path       string                    `json:"path,omitempty"`
	Status     receiptStatus             `json:"status"`
	Repair     string                    `json:"repair,omitempty"`
	Generation *pluginGenerationIdentity `json:"generation,omitempty"`
}

type receiptPluginManifest struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Skills  string `json:"skills"`
	Hooks   string `json:"hooks"`
}

type receiptClaudeSettings struct {
	EnabledPlugins         map[string]bool           `json:"enabledPlugins"`
	ExtraKnownMarketplaces map[string]map[string]any `json:"extraKnownMarketplaces"`
}

type receiptPluginSource struct {
	Source string `json:"source"`
	Path   string `json:"path"`
	URL    string `json:"url"`
}

type receiptInstalledPlugin struct {
	PluginID        string              `json:"pluginId"`
	ID              string              `json:"id"`
	Name            string              `json:"name"`
	MarketplaceName string              `json:"marketplaceName"`
	Version         string              `json:"version"`
	Installed       bool                `json:"installed"`
	Enabled         bool                `json:"enabled"`
	InstallPath     string              `json:"installPath"`
	Source          receiptPluginSource `json:"source"`
	Marketplace     receiptPluginSource `json:"marketplaceSource"`
}

// setupReceiptCmd is a read-only setup diagnostic. It is a subcommand rather
// than a top-level doctor so its scope remains the installation boundary.
var setupReceiptCmd = &cobra.Command{
	Use:   "receipt",
	Short: "Report the installed runtime receipt",
	Long: `Report the executable, enabled skill/plugin bundles, hook compatibility,
and the running Shuttle daemon contract. Use --json for the machine-readable
receipt consumed by setup and deployment checks. A healthy receipt requires
every component that is enabled on this host to be present and compatible.`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		receipt := collectRuntimeReceipt()
		if jsonOutput {
			if err := outputJSON(receipt); err != nil {
				return err
			}
			if receipt.Status != receiptHealthy {
				return fmt.Errorf("runtime receipt is %s", receipt.Status)
			}
			return nil
		}
		fmt.Printf("runtime %s\n", receipt.Status)
		if receipt.Repair != "" {
			fmt.Printf("repair: %s\n", receipt.Repair)
		}
		if receipt.Status != receiptHealthy {
			return fmt.Errorf("runtime receipt is %s", receipt.Status)
		}
		return nil
	},
}

func init() { setupCmd.AddCommand(setupReceiptCmd) }

func collectRuntimeReceipt() RuntimeReceipt {
	r := RuntimeReceipt{Schema: 1, Bundles: []ReceiptBundle{}}
	r.Felt = collectFeltReceipt()
	r.Bundles = collectCodexBundle()
	r.Bundles = append(r.Bundles, collectClaudeBundle()...)
	r.Hooks = collectHookReceipt(r.Bundles)
	r.Daemon = collectDaemonReceipt()
	r.Generation = collectGenerationReceipt(r.Bundles, r.Felt)
	r.Status, r.Repair = combineReceiptStatus(r.Felt.Status, r.Bundles, r.Hooks.Status, r.Daemon.Status, r.Generation.Status)
	if r.Generation.Status != receiptHealthy && r.Generation.Status == r.Status {
		r.Repair = r.Generation.Repair
	}
	return r
}

func collectFeltReceipt() ReceiptComponent {
	path := resolveReceiptFelt()
	if path == "" {
		return ReceiptComponent{Status: receiptMissing, Repair: "install felt or put it on PATH (the hooks probe PATH and ~/.local/bin/felt)"}
	}
	version := receiptExecutableVersion(path)
	if version == "" {
		return ReceiptComponent{Status: receiptMismatch, Path: path, Repair: "run the resolved felt executable with --version; replace a non-felt or unreadable binary"}
	}
	return ReceiptComponent{Status: receiptHealthy, Path: path, Version: version}
}

func resolveReceiptFelt() string {
	if p := os.Getenv("FELT_BIN"); p != "" && executableFile(p) {
		return p
	}
	if p, err := exec.LookPath("felt"); err == nil && executableFile(p) {
		return p
	}
	home, _ := os.UserHomeDir()
	for _, p := range []string{filepath.Join(home, ".local", "bin", "felt"), "/opt/homebrew/bin/felt", "/usr/local/bin/felt"} {
		if executableFile(p) {
			return p
		}
	}
	return ""
}

func executableFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir() && info.Mode()&0o111 != 0
}

func receiptExecutableVersion(path string) string {
	out, err := exec.Command(path, "--version").Output()
	if err != nil {
		return ""
	}
	line := strings.TrimSpace(strings.SplitN(string(out), "\n", 2)[0])
	line = strings.TrimSpace(strings.TrimPrefix(line, "felt version"))
	fields := strings.Fields(line)
	if len(fields) == 0 {
		return ""
	}
	return fields[0]
}

func collectCodexBundle() []ReceiptBundle {
	if _, err := exec.LookPath("codex"); err == nil {
		out, err := exec.Command("codex", "plugin", "list", "--json").Output()
		if err == nil {
			var response struct {
				Installed []receiptInstalledPlugin `json:"installed"`
			}
			if json.Unmarshal(out, &response) == nil {
				for _, plugin := range response.Installed {
					if plugin.PluginID != codexPluginRef && !(plugin.Name == "felt" && plugin.MarketplaceName == marketplaceName) {
						continue
					}
					if !plugin.Enabled {
						return nil
					}
					return []ReceiptBundle{bundleFromActivePlugin("codex", plugin)}
				}
				// A host may intentionally use only Claude (or only Codex). The
				// authoritative list omitting Felt is therefore not itself a
				// failure; consult local wiring only to catch an interrupted or
				// orphaned Felt setup.
				return collectCodexBundleFallback()
			}
		}
		// A present CLI whose structured output cannot be read is not safe to
		// interpret as a healthy cache; make the degraded boundary visible.
		return []ReceiptBundle{{Harness: "codex", Enabled: true, Evidence: "codex plugin list unavailable", Status: receiptPartial, Repair: "upgrade Codex or repair its plugin list, then rerun `felt setup codex`"}}
	}
	return collectCodexBundleFallback()
}

func collectCodexBundleFallback() []ReceiptBundle {
	home, _ := os.UserHomeDir()
	cfg, err := readCodexConfig()
	if err != nil {
		return []ReceiptBundle{{Harness: "codex", Enabled: true, Status: receiptMismatch, Repair: "repair ~/.codex/config.toml, then rerun `felt setup codex`"}}
	}
	plugins, _ := cfg["plugins"].(map[string]interface{})
	enabled, configured := false, false
	if value, ok := plugins[codexPluginRef]; ok {
		configured = true
		if plugin, ok := value.(map[string]interface{}); ok {
			enabled, _ = plugin["enabled"].(bool)
		}
	}
	root := filepath.Join(home, ".codex", "plugins", "cache", marketplaceName, "felt")
	manifestPaths, _ := filepath.Glob(filepath.Join(root, "*", ".codex-plugin", "plugin.json"))
	if !enabled && len(manifestPaths) == 0 {
		return nil // Codex is not part of this host's enabled installation.
	}
	if !enabled {
		return []ReceiptBundle{{Harness: "codex", Path: root, Enabled: false, Status: receiptPartial, Repair: "remove the orphaned Codex cache or enable it with `felt setup codex`"}}
	}
	if len(manifestPaths) != 1 {
		return []ReceiptBundle{{Harness: "codex", Path: root, Enabled: true, Status: receiptMissing, Repair: "run `felt setup codex` to materialize exactly one active plugin cache"}}
	}
	b := bundleFromManifest("codex", manifestPaths[0], codexSource(cfg))
	b.Evidence = "config/cache fallback"
	if b.Status == receiptHealthy {
		b.Status = receiptPartial
		b.Repair = "install Codex so the active plugin source can be verified, then rerun the receipt"
	}
	if !configured {
		b.Status = receiptPartial
		b.Repair = "restore the Codex marketplace/plugin entry with `felt setup codex`"
	}
	return []ReceiptBundle{b}
}

func codexSource(cfg map[string]interface{}) string {
	markets, _ := cfg["marketplaces"].(map[string]interface{})
	m, _ := markets[marketplaceName].(map[string]interface{})
	if source, _ := m["source"].(string); source != "" {
		return source
	}
	return ""
}

func collectClaudeBundle() []ReceiptBundle {
	if _, err := exec.LookPath("claude"); err == nil {
		out, err := exec.Command("claude", "plugin", "list", "--json").Output()
		if err == nil {
			var plugins []receiptInstalledPlugin
			if json.Unmarshal(out, &plugins) == nil {
				for _, plugin := range plugins {
					if plugin.PluginID != "felt@"+marketplaceName && plugin.ID != "felt@"+marketplaceName {
						continue
					}
					if !plugin.Enabled {
						return nil
					}
					bundle := bundleFromActivePlugin("claude", plugin)
					if bundle.Source == "" {
						bundle.Source = claudeConfiguredSource()
					}
					return []ReceiptBundle{bundle}
				}
				// No Felt entry is a valid single-harness installation when there
				// is no local Felt wiring to recover. The fallback distinguishes
				// that state from an enabled-but-missing cache.
				return collectClaudeBundleFallback()
			}
		}
		return []ReceiptBundle{{Harness: "claude", Enabled: true, Evidence: "claude plugin list unavailable", Status: receiptPartial, Repair: "upgrade Claude Code or repair its plugin list, then rerun `felt setup claude`"}}
	}
	return collectClaudeBundleFallback()
}

func bundleFromActivePlugin(harness string, plugin receiptInstalledPlugin) ReceiptBundle {
	root := plugin.Source.Path
	if harness == "claude" {
		root = plugin.InstallPath
	}
	if root == "" {
		return ReceiptBundle{Harness: harness, Version: plugin.Version, Enabled: plugin.Enabled, Evidence: harness + " plugin list", Status: receiptMissing, Repair: "run the matching felt setup command to restore the active plugin path"}
	}
	manifest := filepath.Join(root, ".codex-plugin", "plugin.json")
	if harness == "claude" {
		manifest = filepath.Join(root, ".claude-plugin", "plugin.json")
	}
	b := bundleFromManifest(harness, manifest, plugin.Marketplace.Source)
	b.Path = root
	b.Version = plugin.Version
	b.Evidence = harness + " plugin list"
	if b.Status == receiptHealthy && plugin.Version == "" {
		b.Status, b.Repair = receiptMismatch, "the harness did not report a plugin version; reinstall the felt plugin"
	}
	if b.Status == receiptHealthy && plugin.Version != "" {
		if manifestVersion := readPluginVersion(manifest); manifestVersion != plugin.Version {
			b.Status, b.Repair = receiptMismatch, "the harness and plugin manifest disagree; reinstall the felt plugin"
		}
	}
	return b
}

func collectClaudeBundleFallback() []ReceiptBundle {
	home, _ := os.UserHomeDir()
	data, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return []ReceiptBundle{{Harness: "claude", Enabled: true, Status: receiptMismatch, Repair: "repair ~/.claude/settings.json, then rerun `felt setup claude`"}}
	}
	var settings receiptClaudeSettings
	if err := json.Unmarshal(data, &settings); err != nil {
		return []ReceiptBundle{{Harness: "claude", Enabled: true, Status: receiptMismatch, Repair: "repair ~/.claude/settings.json, then rerun `felt setup claude`"}}
	}
	if !settings.EnabledPlugins["felt@"+marketplaceName] {
		return nil
	}
	root := claudeMarketplaceClonePath()
	manifest := filepath.Join(root, "claude-plugin", ".claude-plugin", "plugin.json")
	if _, err := os.Stat(manifest); err != nil {
		return []ReceiptBundle{{Harness: "claude", Enabled: true, Path: root, Status: receiptMissing, Repair: "run `felt setup claude` to restore the enabled marketplace clone"}}
	}
	source := claudeConfiguredSourceFrom(settings)
	b := bundleFromManifest("claude", manifest, source)
	b.Evidence = "settings/cache fallback"
	if b.Status == receiptHealthy {
		b.Status = receiptPartial
		b.Repair = "install Claude Code so the active plugin path can be verified, then rerun the receipt"
	}
	return []ReceiptBundle{b}
}

func claudeConfiguredSource() string {
	home, _ := os.UserHomeDir()
	data, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	if err != nil {
		return ""
	}
	var settings receiptClaudeSettings
	if json.Unmarshal(data, &settings) != nil {
		return ""
	}
	return claudeConfiguredSourceFrom(settings)
}

func claudeConfiguredSourceFrom(settings receiptClaudeSettings) string {
	m := settings.ExtraKnownMarketplaces[marketplaceName]
	if s, _ := m["source"].(map[string]any); s != nil {
		kind, _ := s["source"].(string)
		if kind == "directory" {
			return stringValue(s["path"])
		}
		if repo := stringValue(s["repo"]); repo != "" {
			return kind + ":" + repo
		}
	}
	return ""
}

func stringValue(value any) string {
	result, _ := value.(string)
	return result
}

func readPluginVersion(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var manifest receiptPluginManifest
	if json.Unmarshal(data, &manifest) != nil {
		return ""
	}
	return manifest.Version
}

func bundleFromManifest(harness, path, source string) ReceiptBundle {
	pluginRoot := filepath.Dir(filepath.Dir(path))
	b := ReceiptBundle{Harness: harness, Path: pluginRoot, Source: source, Enabled: true}
	data, err := os.ReadFile(path)
	if err != nil {
		b.Status, b.Repair = receiptMissing, "restore the plugin manifest with the matching setup command"
		return b
	}
	var manifest receiptPluginManifest
	if err := json.Unmarshal(data, &manifest); err != nil || manifest.Name != "felt" || manifest.Version == "" {
		b.Status, b.Repair = receiptMismatch, "install the felt plugin again; its manifest is malformed or belongs to another plugin"
		return b
	}
	b.Version = manifest.Version
	b.Status = receiptHealthy
	if !skillFilesCompatible(pluginRoot) {
		b.Status, b.Repair = receiptMissing, "restore the felt and shuttle skill files with the matching setup command"
		return b
	}
	if Version != "dev" && Version != "" && manifest.Version != Version {
		b.Status, b.Repair = receiptStale, fmt.Sprintf("plugin %s is stale for felt %s; rerun `felt setup %s`", manifest.Version, Version, harness)
	}
	return b
}

func collectHookReceipt(bundles []ReceiptBundle) ReceiptComponent {
	if len(bundles) == 0 {
		return ReceiptComponent{Status: receiptMissing, Repair: "enable a felt Claude or Codex plugin with `felt setup claude` or `felt setup codex`"}
	}
	for _, b := range bundles {
		if b.Status != receiptHealthy {
			return ReceiptComponent{Status: b.Status, Repair: b.Repair}
		}
		root := b.Path
		if !hookFilesCompatible(root) {
			return ReceiptComponent{Status: receiptMismatch, Path: root, Repair: fmt.Sprintf("rerun `felt setup %s` to restore the SessionStart and PreToolUse hooks", b.Harness)}
		}
		if b.Harness == "codex" && strings.Contains(b.Evidence, "plugin list") && !codexHooksTrusted() {
			return ReceiptComponent{Status: receiptMismatch, Path: root, Repair: "open a Codex session and approve felt's hooks, then rerun the receipt"}
		}
	}
	return ReceiptComponent{Status: receiptHealthy}
}

func hookFilesCompatible(pluginRoot string) bool {
	hooks := filepath.Join(pluginRoot, "hooks")
	for _, name := range []string{"hooks.json", "session.sh", "felt-bin.sh"} {
		path := filepath.Join(hooks, name)
		if _, err := os.Stat(path); err != nil {
			return false
		}
		if name != "hooks.json" && !executableFile(path) {
			return false
		}
	}
	data, err := os.ReadFile(filepath.Join(hooks, "hooks.json"))
	if err != nil {
		return false
	}
	var doc map[string]any
	if json.Unmarshal(data, &doc) != nil {
		return false
	}
	hookDoc, ok := doc["hooks"].(map[string]any)
	if !ok {
		return false
	}
	session, sessionOK := hookDoc["SessionStart"].([]any)
	_, pretoolOK := hookDoc["PreToolUse"].([]any)
	return sessionOK && pretoolOK && hookCommandPresent(session, "session.sh")
}

func skillFilesCompatible(pluginRoot string) bool {
	for _, name := range []string{"felt/SKILL.md", "shuttle/SKILL.md"} {
		if _, err := os.Stat(filepath.Join(pluginRoot, "skills", name)); err != nil {
			return false
		}
	}
	return true
}

func hookCommandPresent(values []any, suffix string) bool {
	for _, value := range values {
		if hookValueContains(value, suffix) {
			return true
		}
	}
	return false
}

func hookValueContains(value any, suffix string) bool {
	switch value := value.(type) {
	case string:
		return strings.Contains(value, suffix)
	case []any:
		for _, child := range value {
			if hookValueContains(child, suffix) {
				return true
			}
		}
	case map[string]any:
		for _, child := range value {
			if hookValueContains(child, suffix) {
				return true
			}
		}
	}
	return false
}

func codexHooksTrusted() bool {
	cfg, err := readCodexConfig()
	if err != nil {
		return false
	}
	state, _ := cfg["hooks"].(map[string]interface{})
	state, _ = state["state"].(map[string]interface{})
	seen := map[string]bool{}
	for key, value := range state {
		if !strings.HasPrefix(key, codexPluginRef+":hooks/hooks.json:") {
			continue
		}
		if entry, ok := value.(map[string]interface{}); ok {
			if hash, _ := entry["trusted_hash"].(string); hash != "" {
				if strings.Contains(key, ":session_start:") {
					seen["session_start"] = true
				}
				if strings.Contains(key, ":pre_tool_use:") {
					seen["pre_tool_use"] = true
				}
			}
		}
	}
	return seen["session_start"] && seen["pre_tool_use"]
}

func collectDaemonReceipt() ReceiptDaemon {
	d := ReceiptDaemon{URL: daemonURL(), Status: receiptMissing, Repair: "start the Shuttle daemon, then rerun `felt setup receipt --json`"}
	data, err := getDaemon(strings.TrimRight(daemonURL(), "/")+"/api/v1/version", daemonReadTimeout)
	if err != nil {
		return d
	}
	var response struct {
		Contract struct {
			Expected json.RawMessage `json:"expected"`
			Observed json.RawMessage `json:"observed"`
			OK       *bool           `json:"ok"`
		} `json:"contract"`
	}
	if json.Unmarshal(data, &response) != nil || len(response.Contract.Expected) == 0 || len(response.Contract.Observed) == 0 {
		d.Status, d.Repair = receiptMismatch, "upgrade or restart Shuttle so /api/v1/version exposes the contract receipt"
		return d
	}
	d.Expected = receiptJSONValue(response.Contract.Expected)
	d.Observed = receiptJSONValue(response.Contract.Observed)
	if response.Contract.OK != nil {
		d.Contract = *response.Contract.OK
	}
	if d.Contract && fmt.Sprint(d.Expected) == fmt.Sprint(d.Observed) {
		d.Status, d.Repair = receiptHealthy, ""
	} else {
		d.Status, d.Repair = receiptMismatch, "restart or upgrade the daemon and felt together so their Shuttle contract levels match"
	}
	return d
}

func receiptJSONValue(raw json.RawMessage) any {
	var value any
	if json.Unmarshal(raw, &value) == nil {
		if number, ok := value.(float64); ok && number == float64(int(number)) {
			return int(number)
		}
		return value
	}
	return string(raw)
}

// collectGenerationReceipt compares the marker in the active promoted
// source with every enabled harness cache. Legacy installs without markers are
// reported as partial and repaired by rerunning setup; once either side has a
// marker, both sides must be present, internally valid, and agree.
func collectGenerationReceipt(bundles []ReceiptBundle, felt ReceiptComponent) ReceiptGenerationReceipt {
	receipt := ReceiptGenerationReceipt{Status: receiptHealthy}
	runtimeDir, err := pluginRuntimeDir()
	if err != nil {
		return ReceiptGenerationReceipt{Status: receiptPartial, Repair: fmt.Sprintf("cannot locate the promoted runtime: %v; repair ~/.felt/plugin-runtime and rerun the receipt", err)}
	}
	journalPath := filepath.Join(runtimeDir, pluginJournalName)
	if _, err := os.Stat(journalPath); err == nil {
		return ReceiptGenerationReceipt{
			Status: receiptPartial,
			Repair: fmt.Sprintf("finish or recover the pending plugin promotion at %s, then rerun `felt setup receipt --json`", journalPath),
		}
	} else if !os.IsNotExist(err) {
		return ReceiptGenerationReceipt{Status: receiptPartial, Repair: fmt.Sprintf("cannot inspect pending plugin promotion %s: %v", journalPath, err)}
	}

	activeRoot := filepath.Join(runtimeDir, pluginCurrentName, "claude-plugin")
	receipt.ActivePath = activeRoot
	active, activePresent, activeErr := readPluginGenerationMarker(activeRoot)
	if activeErr != nil {
		return ReceiptGenerationReceipt{Status: receiptPartial, ActivePath: activeRoot, Repair: activeErr.Error()}
	}
	// The marker's felt_build must describe the executable this receipt is
	// diagnosing, not merely agree with a copy of itself in a harness cache.
	// The mismatch is recorded but returned only after the harness loop so a
	// build-skewed receipt still carries its per-harness diagnostics.
	buildSkew := ""
	if activePresent {
		receipt.Active = &active
		if felt.Version != "" && !feltBuildMatchesVersion(active.FeltBuild, felt.Version) {
			buildSkew = fmt.Sprintf("the promoted generation was sealed by felt %q but the resolved executable %s reports %q; rerun the matching felt setup command with that felt", active.FeltBuild, felt.Path, felt.Version)
		}
	}

	anyMarker := activePresent
	harnessCount := 0
	for _, bundle := range bundles {
		if !bundle.Enabled || bundle.Path == "" {
			continue
		}
		harnessCount++
		loaded, loadedPresent, loadedErr := readPluginGenerationMarker(bundle.Path)
		check := ReceiptHarnessGeneration{Harness: bundle.Harness, Path: bundle.Path, Status: receiptHealthy}
		if loadedErr != nil {
			check.Status, check.Repair = receiptPartial, loadedErr.Error()
			receipt.Harnesses = append(receipt.Harnesses, check)
			return generationReceiptWithHarnesses(receipt, receiptPartial, joinReceiptRepairs(check.Repair, buildSkew))
		}
		if loadedPresent {
			check.Generation = &loaded
			anyMarker = true
		}
		receipt.Harnesses = append(receipt.Harnesses, check)

		if activePresent && !loadedPresent {
			return generationReceiptWithHarnesses(receipt, receiptPartial, joinReceiptRepairs(
				fmt.Sprintf("%s's loaded plugin at %s has no %s marker; rerun `felt setup %s`", bundle.Harness, bundle.Path, pluginGenerationMarkerName, bundle.Harness), buildSkew))
		}
		if !activePresent && loadedPresent {
			return generationReceiptWithHarnesses(receipt, receiptPartial, joinReceiptRepairs(
				fmt.Sprintf("the promoted source at %s has no %s marker while %s is loaded; rerun `felt setup %s`", activeRoot, pluginGenerationMarkerName, bundle.Harness, bundle.Harness), buildSkew))
		}
		if activePresent && loadedPresent {
			if status, repair := comparePluginGenerations(active, loaded); status != receiptHealthy {
				check.Status, check.Repair = status, repair
				receipt.Harnesses[len(receipt.Harnesses)-1] = check
				return generationReceiptWithHarnesses(receipt, status, joinReceiptRepairs(repair, buildSkew))
			}
		}
	}
	if buildSkew != "" {
		return generationReceiptWithHarnesses(receipt, receiptMismatch, buildSkew)
	}
	if anyMarker && !activePresent {
		return generationReceiptWithHarnesses(receipt, receiptPartial,
			fmt.Sprintf("a harness cache carries %s but the promoted source does not; rerun the matching felt setup command", pluginGenerationMarkerName))
	}
	if !activePresent && (harnessCount > 0 || directoryExists(filepath.Join(runtimeDir, pluginCurrentName))) {
		return generationReceiptWithHarnesses(receipt, receiptPartial,
			fmt.Sprintf("the active promoted runtime at %s has no %s marker; rerun the matching felt setup command", activeRoot, pluginGenerationMarkerName))
	}
	if activePresent && harnessCount == 0 {
		return generationReceiptWithHarnesses(receipt, receiptPartial,
			fmt.Sprintf("the promoted runtime has %s but no enabled harness reports it loaded; rerun the matching felt setup command", pluginGenerationMarkerName))
	}
	return receipt
}

// feltBuildMatchesVersion compares a generation marker's felt_build against
// the version string the resolved executable prints. The marker may carry
// trailing build metadata ("1.2.3 (abcdef)"), so only the leading version
// field is bound; `--version` output reduces to that same field.
func feltBuildMatchesVersion(feltBuild, version string) bool {
	fields := strings.Fields(feltBuild)
	return len(fields) > 0 && fields[0] == version
}

// joinReceiptRepairs concatenates two repair lines so a harness-level failure
// does not silently drop a concurrent felt_build skew (the receipt carries a
// single Repair string).
func joinReceiptRepairs(primary, secondary string) string {
	if secondary == "" {
		return primary
	}
	return primary + "; also: " + secondary
}

func generationReceiptWithHarnesses(receipt ReceiptGenerationReceipt, status receiptStatus, repair string) ReceiptGenerationReceipt {
	receipt.Status, receipt.Repair = status, repair
	return receipt
}

func readPluginGenerationMarker(pluginRoot string) (pluginGenerationIdentity, bool, error) {
	path := filepath.Join(pluginRoot, pluginGenerationMarkerName)
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return pluginGenerationIdentity{}, false, nil
	} else if err != nil {
		return pluginGenerationIdentity{}, true, fmt.Errorf("cannot inspect %s: %v; rerun the matching felt setup command", path, err)
	}
	identity, err := validatePluginGeneration(pluginRoot)
	if err != nil {
		return pluginGenerationIdentity{}, true, fmt.Errorf("invalid active generation at %s: %v; rerun the matching felt setup command", path, err)
	}
	return identity, true, nil
}

func directoryExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func comparePluginGenerations(active, loaded pluginGenerationIdentity) (receiptStatus, string) {
	fields := []struct {
		name string
		want string
		got  string
	}{
		{"source kind", active.SourceKind, loaded.SourceKind},
		{"source", active.Source, loaded.Source},
		{"requested ref", active.RequestedRef, loaded.RequestedRef},
		{"resolved commit", active.ResolvedCommit, loaded.ResolvedCommit},
		{"plugin version", active.PluginVersion, loaded.PluginVersion},
		{"felt build", active.FeltBuild, loaded.FeltBuild},
		{"payload digest", active.PayloadSHA256, loaded.PayloadSHA256},
	}
	for _, field := range fields {
		if field.want != field.got {
			return receiptMismatch, fmt.Sprintf("active promoted source and loaded harness cache disagree on %s (%q vs %q); rerun the matching felt setup command", field.name, field.want, field.got)
		}
	}
	return receiptHealthy, ""
}

func combineReceiptStatus(felt receiptStatus, bundles []ReceiptBundle, hooks, daemon receiptStatus, extra ...receiptStatus) (receiptStatus, string) {
	statuses := []receiptStatus{felt, hooks, daemon}
	for _, b := range bundles {
		statuses = append(statuses, b.Status)
	}
	statuses = append(statuses, extra...)
	for _, status := range []receiptStatus{receiptMismatch, receiptStale} {
		for _, got := range statuses {
			if got == status {
				return status, receiptRepair(statuses, status)
			}
		}
	}
	hasHealthy, hasMissing := false, false
	for _, status := range statuses {
		hasHealthy = hasHealthy || status == receiptHealthy
		hasMissing = hasMissing || status == receiptMissing
		if status == receiptPartial {
			return receiptPartial, "complete the partially installed felt runtime, then rerun the receipt"
		}
	}
	if hasMissing && hasHealthy {
		return receiptPartial, "complete the missing felt runtime component, then rerun the receipt"
	}
	if hasMissing {
		return receiptMissing, "install felt integrations and start Shuttle, then rerun the receipt"
	}
	return receiptHealthy, ""
}

func receiptRepair(_ []receiptStatus, status receiptStatus) string {
	if status == receiptMismatch {
		return "repair the mismatched felt plugin, hooks, or daemon contract, then rerun the receipt"
	}
	return "rerun the matching felt setup command to refresh the stale plugin bundle"
}
