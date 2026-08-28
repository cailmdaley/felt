package cmd

// The agent CLIs own their caches, but felt owns the source it gives them.
// Keep that source transition transactional: a process dying between the two
// renames must not turn a good checkout into a missing marketplace.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	internalfelt "github.com/cailmdaley/felt/internal/felt"
)

const (
	pluginRuntimeDirName = "plugin-runtime"
	pluginCurrentName    = "current"
	pluginPreviousName   = "previous"
	pluginJournalName    = "promotion.json"
	pluginAcquirePrefix  = ".acquire-"
)

type pluginPromotionJournal struct {
	Candidate string              `json:"candidate"`
	Phase     string              `json:"phase"` // prepared, swapped, committed
	HadOld    bool                `json:"had_old"`
	Native    *pluginNativeIntent `json:"native,omitempty"`
}

// pluginNativeIntent is the activation state that existed before a
// filesystem promotion began. It is deliberately persisted in the journal:
// a process can die after a native CLI has mutated its cache/config, before it
// gets a chance to run the in-process rollback callback.
type pluginNativeIntent struct {
	Claude *claudeInstallationState `json:"claude,omitempty"`
	Codex  *codexInstallationState  `json:"codex,omitempty"`
}

type marketplaceManifest struct {
	Name    string `json:"name"`
	Plugins []struct {
		Name   string `json:"name"`
		Source string `json:"source"`
	} `json:"plugins"`
}

type pluginManifest struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Skills  string `json:"skills"`
	Hooks   string `json:"hooks"`
}

type claudeInstallationState struct {
	Marketplace claudeMarketplaceEntry
	Configured  bool
	Installed   bool
}

type codexInstallationState struct {
	Source     string
	Configured bool
	Installed  bool
}

func captureClaudeInstallation() claudeInstallationState {
	// Native capture must describe the filesystem generation that will remain
	// active. Recovery is intentionally first: a kill during native activation
	// can leave the candidate in current while the journal still points at the
	// last known-good previous copy.
	if !recoverPluginRuntimeBeforeNativeCapture() {
		return claudeInstallationState{}
	}
	return captureClaudeInstallationRaw()
}

func claudeMarketplaceSource(entry claudeMarketplaceEntry) string {
	if entry.Path != "" {
		return entry.Path
	}
	if entry.Source == "directory" && entry.InstallLocation != "" {
		return entry.InstallLocation
	}
	if entry.Repo != "" {
		return entry.Repo
	}
	// Claude's JSON shape has changed between releases. Keep accepting a
	// non-kind source string, but never mistake the discriminator "git" or
	// "directory" for a usable rollback source.
	if entry.Source != "" && entry.Source != "git" && entry.Source != "directory" {
		return entry.Source
	}
	return ""
}

func restoreClaudeInstallation(state claudeInstallationState) error {
	if _, err := exec.LookPath("claude"); err != nil {
		return fmt.Errorf("claude CLI unavailable while restoring native installation: %w", err)
	}
	pluginRef := "felt@" + marketplaceName
	if !state.Configured {
		// The failed candidate may have installed the plugin before returning an
		// error. Best effort uninstall is safe for the absent-plugin case.
		_, _ = exec.Command("claude", "plugin", "uninstall", pluginRef).Output()
		if err := runClaudeCLI("plugin", "marketplace", "remove", marketplaceName); err != nil {
			return fmt.Errorf("removing failed marketplace: %w", err)
		}
		return nil
	}
	source := claudeMarketplaceSource(state.Marketplace)
	if source == "" {
		return errors.New("previous Claude marketplace source is not recoverable from CLI JSON")
	}
	if err := runClaudeCLI("plugin", "marketplace", "add", source); err != nil {
		return fmt.Errorf("restoring Claude marketplace: %w", err)
	}
	if state.Installed {
		if err := runClaudeCLI("plugin", "update", pluginRef); err != nil {
			return fmt.Errorf("restoring Claude plugin: %w", err)
		}
	} else {
		_, _ = exec.Command("claude", "plugin", "uninstall", pluginRef).Output()
	}
	return nil
}

func captureCodexInstallation() codexInstallationState {
	if !recoverPluginRuntimeBeforeNativeCapture() {
		return codexInstallationState{}
	}
	if _, err := exec.LookPath("codex"); err != nil {
		return codexInstallationState{}
	}
	source, configured := codexMarketplaceState()
	return codexInstallationState{Source: source, Configured: configured, Installed: codexPluginInstalled()}
}

func recoverPluginRuntimeBeforeNativeCapture() bool {
	runtimeDir, err := pluginRuntimeDir()
	if err != nil {
		return false
	}
	// The caller with a full setup operation will surface this error when it
	// reaches staging. Capture functions cannot return an error without
	// changing their long-standing API, so they only provide the ordering
	// guarantee here.
	return recoverPluginPromotion(runtimeDir) == nil
}

func codexMarketplaceState() (string, bool) {
	out, err := runCodexCLIQuiet("plugin", "marketplace", "list", "--json")
	if err != nil {
		return "", false
	}
	var document struct {
		Marketplaces []struct {
			Name              string `json:"name"`
			Root              string `json:"root"`
			MarketplaceSource struct {
				SourceType string `json:"sourceType"`
				Source     string `json:"source"`
			} `json:"marketplaceSource"`
		} `json:"marketplaces"`
	}
	if json.Unmarshal([]byte(out), &document) == nil && document.Marketplaces != nil {
		for _, entry := range document.Marketplaces {
			if entry.Name == marketplaceName {
				if entry.MarketplaceSource.SourceType == "directory" && entry.Root != "" {
					return entry.Root, true
				}
				return entry.MarketplaceSource.Source, true
			}
		}
	}
	// Older Codex builds returned a top-level array. Keep the fallback for
	// already-installed clients while preferring the current object shape.
	var entries []map[string]interface{}
	if json.Unmarshal([]byte(out), &entries) == nil {
		for _, entry := range entries {
			name, _ := entry["name"].(string)
			if name == marketplaceName {
				return codexEntrySource(entry), true
			}
		}
	}
	return "", false
}

func codexEntrySource(entry map[string]interface{}) string {
	for _, key := range []string{"path", "url", "repo", "source"} {
		if value, ok := entry[key].(string); ok && value != "" && value != "directory" && value != "git" {
			return value
		}
	}
	return ""
}

func codexPluginInstalled() bool {
	out, err := runCodexCLIQuiet("plugin", "list", "--json")
	if err != nil {
		return false
	}
	var document struct {
		Installed []struct {
			PluginID string `json:"pluginId"`
			ID       string `json:"id"`
		} `json:"installed"`
	}
	if json.Unmarshal([]byte(out), &document) == nil && document.Installed != nil {
		for _, entry := range document.Installed {
			if entry.PluginID == codexPluginRef || entry.ID == codexPluginRef {
				return true
			}
		}
	}
	var entries []struct {
		ID string `json:"id"`
	}
	if json.Unmarshal([]byte(out), &entries) == nil {
		for _, entry := range entries {
			if entry.ID == codexPluginRef {
				return true
			}
		}
	}
	return false
}

func restoreCodexInstallation(state codexInstallationState) error {
	if _, err := exec.LookPath("codex"); err != nil {
		return fmt.Errorf("codex CLI unavailable while restoring native installation: %w", err)
	}
	if !state.Configured || state.Source == "" {
		_, _ = runCodexCLIQuiet("plugin", "remove", codexPluginRef)
		out, err := runCodexCLIQuiet("plugin", "marketplace", "remove", marketplaceName)
		return reportCodexRemoval(out, err)
	}
	// A failed candidate install can leave its marketplace registered under the
	// same name. Codex rejects adding a different source for an existing name,
	// so restoration must first clear the candidate registration.
	removeOut, removeErr := runCodexCLIQuiet("plugin", "marketplace", "remove", marketplaceName)
	if err := reportCodexRemoval(removeOut, removeErr); err != nil {
		return fmt.Errorf("removing failed Codex marketplace: %w", err)
	}
	if _, err := runCodexCLIQuiet("plugin", "marketplace", "add", state.Source); err != nil {
		return fmt.Errorf("restoring Codex marketplace: %w", err)
	}
	if state.Installed {
		if err := runCodexCLI("plugin", "add", codexPluginRef); err != nil {
			return fmt.Errorf("restoring Codex plugin: %w", err)
		}
	} else {
		_, _ = runCodexCLIQuiet("plugin", "remove", codexPluginRef)
	}
	return nil
}

// validatePluginCandidate checks the complete payload before an installer can
// point an agent CLI at it. It deliberately validates both plugin manifests:
// Claude and Codex must be one generation, not merely individually parseable.
// executable may be empty for structural tests; the setup command supplies the
// running felt executable so the daemon-facing contract is checked in reality.
func validatePluginCandidate(root, executable string) error {
	market, err := readJSONFile[marketplaceManifest](filepath.Join(root, ".claude-plugin", "marketplace.json"))
	if err != nil {
		return fmt.Errorf("marketplace manifest: %w", err)
	}
	if market.Name != marketplaceName {
		return fmt.Errorf("marketplace manifest name %q, want %q", market.Name, marketplaceName)
	}
	if len(market.Plugins) != 1 || market.Plugins[0].Name != "felt" || market.Plugins[0].Source != "./claude-plugin" {
		return errors.New("marketplace manifest must expose exactly felt from ./claude-plugin")
	}

	pluginDir := filepath.Join(root, "claude-plugin")
	claude, err := readJSONFile[pluginManifest](filepath.Join(pluginDir, ".claude-plugin", "plugin.json"))
	if err != nil {
		return fmt.Errorf("Claude plugin manifest: %w", err)
	}
	codex, err := readJSONFile[pluginManifest](filepath.Join(pluginDir, ".codex-plugin", "plugin.json"))
	if err != nil {
		return fmt.Errorf("Codex plugin manifest: %w", err)
	}
	if claude.Name != "felt" || codex.Name != "felt" {
		return fmt.Errorf("plugin manifests must both name felt (Claude=%q Codex=%q)", claude.Name, codex.Name)
	}
	if claude.Version == "" || claude.Version != codex.Version {
		return fmt.Errorf("plugin manifest versions disagree (Claude=%q Codex=%q)", claude.Version, codex.Version)
	}

	skills := filepath.Join(pluginDir, "skills")
	for _, skill := range []string{"felt", "shuttle"} {
		if !isRegularFile(filepath.Join(skills, skill, "SKILL.md")) {
			return fmt.Errorf("required skill %q is missing SKILL.md", skill)
		}
	}
	if codex.Skills == "" || filepath.Clean(codex.Skills) != "skills" && filepath.Clean(codex.Skills) != "./skills" {
		return fmt.Errorf("Codex plugin manifest has unsupported skills pointer %q", codex.Skills)
	}
	hooksPath := filepath.Join(pluginDir, "hooks", "hooks.json")
	if codex.Hooks == "" || filepath.Clean(codex.Hooks) != filepath.Join("hooks", "hooks.json") && filepath.Clean(codex.Hooks) != filepath.Join(".", "hooks", "hooks.json") {
		return fmt.Errorf("Codex plugin manifest has unsupported hooks pointer %q", codex.Hooks)
	}
	if err := validateHookManifest(hooksPath, pluginDir); err != nil {
		return err
	}

	if executable != "" {
		if err := validateFeltExecutable(executable); err != nil {
			return err
		}
	}
	return nil
}

func readJSONFile[T any](path string) (T, error) {
	var value T
	data, err := os.ReadFile(path)
	if err != nil {
		return value, err
	}
	dec := json.NewDecoder(strings.NewReader(string(data)))
	if err := dec.Decode(&value); err != nil {
		return value, fmt.Errorf("%s: %w", path, err)
	}
	return value, nil
}

func isRegularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

func validateHookManifest(path, pluginDir string) error {
	var document map[string]interface{}
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("hooks manifest: %w", err)
	}
	if err := json.Unmarshal(data, &document); err != nil {
		return fmt.Errorf("hooks manifest: %w", err)
	}
	for _, basename := range []string{"commit.sh", "event.sh", "felt-bin.sh", "session.sh", "touch.sh"} {
		path := filepath.Join(pluginDir, "hooks", basename)
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() || info.Mode()&0o111 == 0 {
			return fmt.Errorf("hook executable %q is missing or not executable", basename)
		}
	}
	if err := validateHookCommands(document); err != nil {
		return err
	}
	return nil
}

func validateHookCommands(value interface{}) error {
	found := false
	var walk func(interface{}) error
	walk = func(value interface{}) error {
		switch value := value.(type) {
		case map[string]interface{}:
			for key, child := range value {
				if key == "command" {
					if command, ok := child.(string); ok && strings.Contains(command, "/hooks/") {
						found = true
						known := false
						for _, basename := range []string{"commit.sh", "event.sh", "felt-bin.sh", "session.sh", "touch.sh"} {
							if strings.Contains(command, "/hooks/"+basename) {
								known = true
							}
						}
						if !known {
							return fmt.Errorf("hooks manifest references unknown hook command %q", command)
						}
					}
				}
				if err := walk(child); err != nil {
					return err
				}
			}
		case []interface{}:
			for _, child := range value {
				if err := walk(child); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := walk(value); err != nil {
		return err
	}
	if !found {
		return errors.New("hooks manifest has no hook commands")
	}
	return nil
}

func validateFeltExecutable(executable string) error {
	info, err := os.Stat(executable)
	if err != nil {
		return fmt.Errorf("felt executable %q: %w", executable, err)
	}
	if !info.Mode().IsRegular() || info.Mode()&0o111 == 0 {
		return fmt.Errorf("felt executable %q is not executable", executable)
	}
	cmd := exec.Command(executable, "shuttle", "contract")
	stdout, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("felt executable %q contract probe: %w", executable, err)
	}
	observed, parseErr := strconv.Atoi(strings.TrimSpace(string(stdout)))
	if parseErr != nil || observed != ShuttleContractLevel || strings.TrimSpace(string(stdout)) != strconv.Itoa(observed) {
		return fmt.Errorf("felt executable %q reports contract %q, want %d", executable, strings.TrimSpace(string(stdout)), ShuttleContractLevel)
	}
	return nil
}

func pluginRuntimeDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("getting home directory: %w", err)
	}
	return filepath.Join(home, ".felt", pluginRuntimeDirName), nil
}

// withPluginPromotionLock serializes capture, source promotion, native CLI
// mutation, and any rollback across setup processes. Atomic renames protect a
// single filesystem operation; this lock protects the transaction they form.
func withPluginPromotionLock(operation func() error) (returnErr error) {
	runtimeDir, err := pluginRuntimeDir()
	if err != nil {
		return err
	}
	unlock, err := internalfelt.LockFiberFile(filepath.Join(runtimeDir, "promotion"))
	if err != nil {
		return fmt.Errorf("locking plugin promotion: %w", err)
	}
	defer func() {
		if unlockErr := unlock(); unlockErr != nil && returnErr == nil {
			returnErr = fmt.Errorf("unlocking plugin promotion: %w", unlockErr)
		}
	}()
	return operation()
}

// stagePluginCandidate copies only the marketplace payload, so a candidate
// cannot accidentally expose a checkout's .git, .felt, or unrelated files.
func stagePluginCandidate(source, executable string) (string, error) {
	root, err := filepath.Abs(source)
	if err != nil {
		return "", err
	}
	if !hasMarketplaceManifest(root) {
		return "", fmt.Errorf("local plugin source %q has no marketplace manifest", source)
	}
	if err := validatePluginCandidate(root, executable); err != nil {
		return "", fmt.Errorf("validating plugin source: %w", err)
	}
	runtimeDir, err := pluginRuntimeDir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(runtimeDir, 0o755); err != nil {
		return "", fmt.Errorf("creating plugin runtime directory: %w", err)
	}
	if err := recoverPluginPromotion(runtimeDir); err != nil {
		return "", err
	}
	candidate, err := os.MkdirTemp(runtimeDir, ".candidate-")
	if err != nil {
		return "", fmt.Errorf("creating plugin candidate: %w", err)
	}
	for _, name := range []string{".claude-plugin", "claude-plugin"} {
		if err := copyTree(filepath.Join(root, name), filepath.Join(candidate, name)); err != nil {
			os.RemoveAll(candidate)
			return "", fmt.Errorf("staging %s: %w", name, err)
		}
	}
	if err := syncTreeDirs(candidate); err != nil {
		os.RemoveAll(candidate)
		return "", fmt.Errorf("syncing staged plugin: %w", err)
	}
	if err := validatePluginCandidate(candidate, executable); err != nil {
		os.RemoveAll(candidate)
		return "", fmt.Errorf("validating staged plugin: %w", err)
	}
	return candidate, nil
}

// promotePluginCandidate atomically swaps current/previous around an
// installer operation. A journal makes both rename gaps recoverable after a
// kill or power loss; only a committed promotion discards the previous copy.
func promotePluginCandidate(candidate string, install func(string) error, restore func() error, intents ...*pluginNativeIntent) error {
	runtimeDir := filepath.Dir(candidate)
	if err := recoverPluginPromotion(runtimeDir); err != nil {
		return err
	}
	var native *pluginNativeIntent
	if len(intents) > 0 {
		native = intents[0]
	}
	current := filepath.Join(runtimeDir, pluginCurrentName)
	previous := filepath.Join(runtimeDir, pluginPreviousName)
	journal := filepath.Join(runtimeDir, pluginJournalName)
	_, oldErr := os.Stat(current)
	hadOld := oldErr == nil
	if oldErr != nil && !os.IsNotExist(oldErr) {
		return fmt.Errorf("checking current plugin: %w", oldErr)
	}
	if err := writePluginJournal(journal, pluginPromotionJournal{Candidate: candidate, Phase: "prepared", HadOld: hadOld, Native: native}); err != nil {
		return err
	}
	if hadOld {
		if err := os.Rename(current, previous); err != nil {
			return fmt.Errorf("parking last known-good plugin: %w", err)
		}
		// Each rename is made durable before the journal advances past it:
		// a journal phase that reached disk ahead of the rename it describes
		// would make recovery destroy the wrong copy.
		if err := syncParentDir(current); err != nil {
			return rollbackPluginPromotion(runtimeDir, candidate, hadOld, fmt.Errorf("parking last known-good plugin: %w", err))
		}
	}
	if err := writePluginJournal(journal, pluginPromotionJournal{Candidate: candidate, Phase: "swapped", HadOld: hadOld, Native: native}); err != nil {
		return rollbackPluginPromotion(runtimeDir, candidate, hadOld, err)
	}
	if err := os.Rename(candidate, current); err != nil {
		return rollbackPluginPromotion(runtimeDir, candidate, hadOld, fmt.Errorf("promoting plugin candidate: %w", err))
	}
	if err := syncParentDir(current); err != nil {
		return rollbackPluginPromotion(runtimeDir, current, hadOld, fmt.Errorf("promoting plugin candidate: %w", err))
	}

	if err := install(current); err != nil {
		cause := fmt.Errorf("plugin candidate rejected: %w; last known-good preserved", err)
		rollbackErr := rollbackPluginPromotion(runtimeDir, current, hadOld, cause)
		if restore != nil {
			if restoreErr := restore(); restoreErr != nil {
				_ = writePluginJournal(journal, pluginPromotionJournal{Candidate: current, Phase: "pending_reconciliation", HadOld: hadOld, Native: native})
				rollbackErr = fmt.Errorf("%w; restoring native installation: %v", rollbackErr, restoreErr)
			}
		} else if native != nil {
			_ = writePluginJournal(journal, pluginPromotionJournal{Candidate: current, Phase: "pending_reconciliation", HadOld: hadOld, Native: native})
		}
		return rollbackErr
	}
	if err := writePluginJournal(journal, pluginPromotionJournal{Candidate: current, Phase: "committed", HadOld: hadOld, Native: native}); err != nil {
		cause := fmt.Errorf("recording committed plugin promotion: %w; last known-good preserved", err)
		rollbackErr := rollbackPluginPromotion(runtimeDir, current, hadOld, cause)
		if restore != nil {
			if restoreErr := restore(); restoreErr != nil {
				_ = writePluginJournal(journal, pluginPromotionJournal{Candidate: current, Phase: "pending_reconciliation", HadOld: hadOld, Native: native})
				rollbackErr = fmt.Errorf("%w; restoring native installation: %v", rollbackErr, restoreErr)
			}
		} else if native != nil {
			_ = writePluginJournal(journal, pluginPromotionJournal{Candidate: current, Phase: "pending_reconciliation", HadOld: hadOld, Native: native})
		}
		return rollbackErr
	}
	if hadOld {
		_ = os.RemoveAll(previous)
	}
	_ = os.Remove(journal)
	// Best-effort: a journal removal lost to power loss is safe (recovery
	// treats a committed journal as cleanup), but making it durable avoids
	// the spurious pending-promotion receipt until the next setup runs.
	_ = syncParentDir(journal)
	return nil
}

func capturePluginNativeIntent() *pluginNativeIntent {
	intent := &pluginNativeIntent{}
	if _, err := exec.LookPath("claude"); err == nil {
		state := captureClaudeInstallation()
		intent.Claude = &state
	}
	if _, err := exec.LookPath("codex"); err == nil {
		state := captureCodexInstallation()
		intent.Codex = &state
	}
	return intent
}

func rollbackPluginPromotion(runtimeDir, candidate string, hadOld bool, cause error) error {
	current := filepath.Join(runtimeDir, pluginCurrentName)
	previous := filepath.Join(runtimeDir, pluginPreviousName)
	if candidate == current {
		_ = os.RemoveAll(current)
	} else {
		_ = os.RemoveAll(candidate)
	}
	if hadOld {
		if err := os.Rename(previous, current); err != nil {
			return fmt.Errorf("%w; restoring last known-good plugin: %v", cause, err)
		}
		// Best-effort: a rollback has no better move on sync failure, so the
		// restored current carries weaker durability than a forward promotion.
		_ = syncParentDir(current)
	}
	_ = os.Remove(filepath.Join(runtimeDir, pluginJournalName))
	return cause
}

func recoverPluginPromotion(runtimeDir string) error {
	journalPath := filepath.Join(runtimeDir, pluginJournalName)
	data, err := os.ReadFile(journalPath)
	if os.IsNotExist(err) {
		// A committed promotion removes `previous`; if an operator copied a
		// runtime directory or an old process died after that cleanup, current
		// remains authoritative. Never let a stale previous block the next
		// atomic rename.
		current := filepath.Join(runtimeDir, pluginCurrentName)
		previous := filepath.Join(runtimeDir, pluginPreviousName)
		_, currentErr := os.Stat(current)
		if currentErr == nil {
			_ = os.RemoveAll(previous)
		} else if os.IsNotExist(currentErr) {
			if _, previousErr := os.Stat(previous); previousErr == nil {
				if err := os.Rename(previous, current); err != nil {
					return fmt.Errorf("recovering orphaned previous plugin: %w", err)
				}
			}
		}
		return nil
	}
	if err != nil {
		return fmt.Errorf("reading plugin promotion journal: %w", err)
	}
	var journal pluginPromotionJournal
	if err := json.Unmarshal(data, &journal); err != nil {
		return fmt.Errorf("decoding plugin promotion journal: %w", err)
	}
	current := filepath.Join(runtimeDir, pluginCurrentName)
	previous := filepath.Join(runtimeDir, pluginPreviousName)
	if journal.Phase == "committed" {
		_ = os.RemoveAll(previous)
		_ = os.Remove(journalPath)
		return nil
	}
	// prepared/swapped means the installer did not reach commit. Prefer the
	// old copy, and discard any candidate that was left in current or staging.
	if journal.HadOld {
		if _, err := os.Stat(previous); err == nil {
			_ = os.RemoveAll(current)
			if err := os.Rename(previous, current); err != nil {
				return fmt.Errorf("recovering last known-good plugin: %w", err)
			}
			_ = syncParentDir(current)
		}
	} else {
		_ = os.RemoveAll(current)
	}
	// Filesystem recovery deliberately precedes native reconciliation. The
	// native CLIs must be pointed at the restored current generation, never at
	// a candidate that happened to be active when the process was killed.
	if journal.Native != nil {
		if err := reconcilePluginNativeIntent(current, journal.Native); err != nil {
			// Keep the journal as a retry token. In particular, an acquisition
			// failure immediately after recovery must not erase the intent needed
			// by the next setup attempt.
			journal.Phase = "pending_reconciliation"
			_ = writePluginJournal(journalPath, journal)
			return fmt.Errorf("reconciling native plugin installation: %w", err)
		}
	}
	if journal.Candidate != "" && journal.Candidate != current {
		_ = os.RemoveAll(journal.Candidate)
	}
	_ = os.Remove(journalPath)
	return nil
}

func reconcilePluginNativeIntent(current string, intent *pluginNativeIntent) error {
	if intent.Claude != nil {
		if err := reconcileClaudeInstallation(*intent.Claude, current); err != nil {
			return err
		}
	}
	if intent.Codex != nil {
		if err := reconcileCodexInstallation(*intent.Codex, current); err != nil {
			return err
		}
	}
	return nil
}

func reconcileClaudeInstallation(intent claudeInstallationState, current string) error {
	if _, err := exec.LookPath("claude"); err != nil {
		return fmt.Errorf("claude CLI unavailable: %w", err)
	}
	// Recovery is retried until it succeeds. If the process died before the
	// native CLI changed anything, the desired absent state is already true;
	// do not turn an idempotent recovery into a permanent pending journal by
	// asking Claude to remove a marketplace which does not exist.
	if state := captureClaudeInstallationRaw(); claudeInstallationMatches(state, intent, current) {
		return nil
	}
	pluginRef := "felt@" + marketplaceName
	if !intent.Configured {
		_, _ = exec.Command("claude", "plugin", "uninstall", pluginRef).Output()
		if err := runClaudeCLI("plugin", "marketplace", "remove", marketplaceName); err != nil {
			return fmt.Errorf("removing Claude marketplace: %w", err)
		}
	} else {
		if err := installClaudePluginAtSource(current); err != nil {
			return fmt.Errorf("reinstalling Claude from restored current: %w", err)
		}
		if !intent.Installed {
			if err := runClaudeCLI("plugin", "uninstall", pluginRef); err != nil {
				return fmt.Errorf("restoring absent Claude plugin: %w", err)
			}
		}
	}
	state := captureClaudeInstallationRaw()
	if state.Configured != intent.Configured || state.Installed != intent.Installed {
		return fmt.Errorf("Claude native state did not reconcile (configured=%t installed=%t, want configured=%t installed=%t)", state.Configured, state.Installed, intent.Configured, intent.Installed)
	}
	if intent.Configured && !samePluginSource(claudeMarketplaceSource(state.Marketplace), current) {
		return fmt.Errorf("Claude marketplace source %q does not point at restored current %q", claudeMarketplaceSource(state.Marketplace), current)
	}
	return nil
}

func claudeInstallationMatches(state, intent claudeInstallationState, current string) bool {
	if state.Configured != intent.Configured || state.Installed != intent.Installed {
		return false
	}
	return !intent.Configured || samePluginSource(claudeMarketplaceSource(state.Marketplace), current)
}

func reconcileCodexInstallation(intent codexInstallationState, current string) error {
	if _, err := exec.LookPath("codex"); err != nil {
		return fmt.Errorf("codex CLI unavailable: %w", err)
	}
	if !intent.Configured {
		_, _ = runCodexCLIQuiet("plugin", "remove", codexPluginRef)
		out, err := runCodexCLIQuiet("plugin", "marketplace", "remove", marketplaceName)
		if err := reportCodexRemoval(out, err); err != nil {
			return fmt.Errorf("removing Codex marketplace: %w", err)
		}
	} else {
		if err := installCodexPluginAtSource(current); err != nil {
			return fmt.Errorf("reinstalling Codex from restored current: %w", err)
		}
		if !intent.Installed {
			if _, err := runCodexCLIQuiet("plugin", "remove", codexPluginRef); err != nil {
				return fmt.Errorf("restoring absent Codex plugin: %w", err)
			}
		}
	}
	source, configured := codexMarketplaceState()
	installed := codexPluginInstalled()
	if configured != intent.Configured || installed != intent.Installed {
		return fmt.Errorf("Codex native state did not reconcile (configured=%t installed=%t, want configured=%t installed=%t)", configured, installed, intent.Configured, intent.Installed)
	}
	if intent.Configured && !samePluginSource(source, current) {
		return fmt.Errorf("Codex marketplace source %q does not point at restored current %q", source, current)
	}
	return nil
}

func captureClaudeInstallationRaw() claudeInstallationState {
	entry, configured := marketplaceEntry(marketplaceName)
	return claudeInstallationState{Marketplace: entry, Configured: configured, Installed: isPluginInstalled("felt@" + marketplaceName)}
}

func samePluginSource(a, b string) bool {
	if a == b {
		return true
	}
	aa, aerr := filepath.Abs(a)
	bb, berr := filepath.Abs(b)
	return aerr == nil && berr == nil && filepath.Clean(aa) == filepath.Clean(bb)
}

func writePluginJournal(path string, journal pluginPromotionJournal) error {
	data, err := json.Marshal(journal)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".promotion-*")
	if err != nil {
		return fmt.Errorf("creating plugin journal: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("committing plugin journal: %w", err)
	}
	// The file itself was fsynced before the rename; syncing the parent
	// directory makes the rename durable, which the recovery path's power-loss
	// guarantee depends on.
	if err := syncParentDir(path); err != nil {
		return fmt.Errorf("committing plugin journal: %w", err)
	}
	return nil
}

// syncParentDir fsyncs the directory containing path so a just-completed
// rename (or removal) survives power loss on filesystems that require an
// explicit directory sync. Filesystems that cannot sync a directory
// (ENOTSUP/EINVAL — some network and FUSE mounts) are tolerated: they never
// offered the durability the sync buys, and refusing to install there would
// trade a narrower crash window for a setup that cannot run at all.
func syncParentDir(path string) error {
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer dir.Close()
	if err := dir.Sync(); err != nil && !tolerableSyncError(err) {
		return fmt.Errorf("syncing directory %s: %w", filepath.Dir(path), err)
	}
	return nil
}

// tolerableSyncError reports fsync refusals from filesystems that simply do
// not support it. ENOTSUP and EOPNOTSUPP are the same errno on Linux but
// distinct on Darwin, so both are listed.
func tolerableSyncError(err error) bool {
	return errors.Is(err, syscall.EINVAL) || errors.Is(err, syscall.ENOTSUP) || errors.Is(err, syscall.EOPNOTSUPP)
}

func copyTree(source, destination string) error {
	return filepath.Walk(source, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		target := filepath.Join(destination, rel)
		if info.IsDir() {
			return os.MkdirAll(target, info.Mode().Perm())
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("plugin payload may not contain symlink %q", rel)
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("unsupported plugin payload entry %q", rel)
		}
		in, err := os.Open(path)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode().Perm())
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(out, in)
		// The payload must be as durable as the marker that describes it: a
		// power loss that keeps a synced marker but truncates payload bytes
		// would otherwise present a valid-looking generation over garbage.
		var syncErr error
		if copyErr == nil {
			syncErr = out.Sync()
		}
		closeErr := out.Close()
		if copyErr != nil {
			return copyErr
		}
		if syncErr != nil && !tolerableSyncError(syncErr) {
			return syncErr
		}
		return closeErr
	})
}

// copyTree copies data; durability of the copied tree's directory entries is
// separate — syncTreeDirs walks the destination and fsyncs each directory so
// a durable marker can never describe payload files whose entries were lost.
func syncTreeDirs(root string) error {
	return filepath.Walk(root, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if !info.IsDir() {
			return nil
		}
		dir, err := os.Open(path)
		if err != nil {
			return err
		}
		defer dir.Close()
		if err := dir.Sync(); err != nil && !tolerableSyncError(err) {
			return fmt.Errorf("syncing directory %s: %w", path, err)
		}
		return nil
	})
}

func currentFeltExecutable() (string, error) {
	if configured := os.Getenv("FELT_BIN"); configured != "" {
		return configured, nil
	}
	path, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("locating felt executable: %w", err)
	}
	return path, nil
}

// withStagedPluginCandidate makes every setup source enter the same validated
// transaction. Remote refs are acquired ephemerally; native harness CLIs see
// only the promoted local generation and continue to own their caches/config.
func withStagedPluginCandidate(source string, install func(string) error) error {
	return withStagedPluginCandidateWithRestore(source, install, nil)
}

func withStagedPluginCandidateWithRestore(source string, install func(string) error, restore func() error) error {
	// Recover before remote acquisition as well as before local staging. This
	// makes a retry after an interrupted native phase deterministic even when
	// the retry's acquisition itself fails.
	runtimeDir, err := pluginRuntimeDir()
	if err != nil {
		return err
	}
	if err := recoverPluginPromotion(runtimeDir); err != nil {
		return err
	}
	if !isLocalPath(source) {
		executable, err := currentFeltExecutable()
		if err != nil {
			return err
		}
		if err := validateFeltExecutable(executable); err != nil {
			return err
		}
		checkout, cleanup, err := acquireRemoteMarketplace(source)
		if err != nil {
			return err
		}
		defer cleanup()
		candidate, err := stagePluginCandidate(checkout, executable)
		if err != nil {
			return err
		}
		identity, err := remotePluginGeneration(source, checkout, candidate)
		if err != nil {
			_ = os.RemoveAll(candidate)
			return err
		}
		if err := sealPluginGeneration(candidate, identity); err != nil {
			_ = os.RemoveAll(candidate)
			return err
		}
		return promotePluginCandidate(candidate, install, restore, capturePluginNativeIntent())
	}
	if !hasMarketplaceManifest(source) {
		return fmt.Errorf("local plugin source %q has no marketplace manifest", source)
	}
	executable, err := currentFeltExecutable()
	if err != nil {
		return err
	}
	candidate, err := stagePluginCandidate(source, executable)
	if err != nil {
		return err
	}
	identity, err := localPluginGeneration(source, candidate)
	if err != nil {
		_ = os.RemoveAll(candidate)
		return err
	}
	if err := sealPluginGeneration(candidate, identity); err != nil {
		_ = os.RemoveAll(candidate)
		return err
	}
	return promotePluginCandidate(candidate, install, restore, capturePluginNativeIntent())
}

// remoteMarketplaceRef is the small subset of GitHub's ref syntax accepted by
// the native marketplace CLIs. Claude spells a pinned ref owner/repo#ref;
// Codex spells it owner/repo@ref. We acquire both forms ourselves so neither
// CLI gets to create an unvalidated persistent checkout.
type remoteMarketplaceRef struct {
	repository string
	ref        string
}

func parseRemoteMarketplaceRef(source string) (remoteMarketplaceRef, error) {
	if source == "" {
		return remoteMarketplaceRef{}, errors.New("empty remote marketplace ref")
	}
	if strings.TrimSpace(source) != source {
		return remoteMarketplaceRef{}, fmt.Errorf("remote marketplace ref %q has surrounding whitespace", source)
	}

	value := source
	ref := ""
	separatorFound := false
	if i := strings.IndexByte(value, '#'); i >= 0 {
		if strings.Contains(value[i+1:], "#") || strings.Contains(value[i+1:], "@") {
			return remoteMarketplaceRef{}, fmt.Errorf("remote marketplace ref %q has multiple revision separators", source)
		}
		separatorFound = true
		ref = value[i+1:]
		value = value[:i]
	} else if i := strings.LastIndexByte(value, '@'); i >= 0 {
		separatorFound = true
		ref = value[i+1:]
		value = value[:i]
	}
	if ref == "" && separatorFound {
		return remoteMarketplaceRef{}, fmt.Errorf("remote marketplace ref %q has an empty revision", source)
	}
	if value != marketplaceRepo {
		return remoteMarketplaceRef{}, fmt.Errorf("unsupported GitHub marketplace %q (want %s[#ref] or %s@ref)", value, marketplaceRepo, marketplaceRepo)
	}
	if !validGitRevision(ref) {
		return remoteMarketplaceRef{}, fmt.Errorf("unsupported GitHub revision in marketplace ref %q", source)
	}
	return remoteMarketplaceRef{repository: value, ref: ref}, nil
}

func validGitRevision(ref string) bool {
	if ref == "" {
		return true
	}
	if strings.HasPrefix(ref, ".") || strings.HasPrefix(ref, "-") || strings.HasPrefix(ref, "/") ||
		strings.HasSuffix(ref, ".") || strings.HasSuffix(ref, "/") || strings.HasSuffix(ref, ".lock") {
		return false
	}
	return !strings.ContainsAny(ref, " \t\r\n\\~^:?*[") &&
		!strings.Contains(ref, "..") && !strings.Contains(ref, "//") && !strings.Contains(ref, "@{")
}

// acquireRemoteMarketplace uses git only as an ephemeral acquisition
// mechanism. Acquisitions live under the locked runtime directory so a later
// setup can reap debris left by SIGKILL or power loss. Their contents are
// copied into the validated Felt candidate before any native installer runs.
func acquireRemoteMarketplace(source string) (string, func(), error) {
	ref, err := parseRemoteMarketplaceRef(source)
	if err != nil {
		return "", func() {}, err
	}
	runtimeDir, err := pluginRuntimeDir()
	if err != nil {
		return "", func() {}, err
	}
	if err := os.MkdirAll(runtimeDir, 0o755); err != nil {
		return "", func() {}, fmt.Errorf("creating plugin runtime directory: %w", err)
	}
	stale, err := filepath.Glob(filepath.Join(runtimeDir, pluginAcquirePrefix+"*"))
	if err != nil {
		return "", func() {}, fmt.Errorf("finding stale marketplace acquisitions: %w", err)
	}
	for _, path := range stale {
		if err := os.RemoveAll(path); err != nil {
			return "", func() {}, fmt.Errorf("removing stale marketplace acquisition %q: %w", path, err)
		}
	}
	parent, err := os.MkdirTemp(runtimeDir, pluginAcquirePrefix)
	if err != nil {
		return "", func() {}, fmt.Errorf("creating temporary marketplace checkout: %w", err)
	}
	cleanup := func() { _ = os.RemoveAll(parent) }
	args := []string{"clone", "--depth", "1"}
	if ref.ref != "" {
		args = append(args, "--branch="+ref.ref)
	}
	args = append(args, "--", "https://github.com/"+ref.repository+".git", parent)
	output, err := exec.Command("git", args...).CombinedOutput()
	if err != nil {
		cleanup()
		message := strings.TrimSpace(string(output))
		if message != "" {
			return "", func() {}, fmt.Errorf("acquiring remote marketplace %q: %w: %s", source, err, message)
		}
		return "", func() {}, fmt.Errorf("acquiring remote marketplace %q: %w", source, err)
	}
	if !hasMarketplaceManifest(parent) {
		cleanup()
		return "", func() {}, fmt.Errorf("acquired remote marketplace %q has no marketplace manifest", source)
	}
	return parent, cleanup, nil
}
