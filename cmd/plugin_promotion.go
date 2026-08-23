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

	internalfelt "github.com/cailmdaley/felt/internal/felt"
)

const (
	pluginRuntimeDirName = "plugin-runtime"
	pluginCurrentName    = "current"
	pluginPreviousName   = "previous"
	pluginJournalName    = "promotion.json"
)

type pluginPromotionJournal struct {
	Candidate string `json:"candidate"`
	Phase     string `json:"phase"` // prepared, swapped, committed
	HadOld    bool   `json:"had_old"`
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
	entry, configured := marketplaceEntry(marketplaceName)
	return claudeInstallationState{
		Marketplace: entry,
		Configured:  configured,
		Installed:   isPluginInstalled("felt@" + marketplaceName),
	}
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
	if _, err := exec.LookPath("codex"); err != nil {
		return codexInstallationState{}
	}
	source, configured := codexMarketplaceState()
	return codexInstallationState{Source: source, Configured: configured, Installed: codexPluginInstalled()}
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
	for _, basename := range []string{"commit.sh", "event.sh", "felt-bin.sh", "remind.sh", "session.sh", "touch.sh"} {
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
						for _, basename := range []string{"commit.sh", "event.sh", "felt-bin.sh", "remind.sh", "session.sh", "touch.sh"} {
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
	if err := validatePluginCandidate(candidate, executable); err != nil {
		os.RemoveAll(candidate)
		return "", fmt.Errorf("validating staged plugin: %w", err)
	}
	return candidate, nil
}

// promotePluginCandidate atomically swaps current/previous around an
// installer operation. A journal makes both rename gaps recoverable after a
// kill or power loss; only a committed promotion discards the previous copy.
func promotePluginCandidate(candidate string, install func(string) error, restore func() error) error {
	runtimeDir := filepath.Dir(candidate)
	if err := recoverPluginPromotion(runtimeDir); err != nil {
		return err
	}
	current := filepath.Join(runtimeDir, pluginCurrentName)
	previous := filepath.Join(runtimeDir, pluginPreviousName)
	journal := filepath.Join(runtimeDir, pluginJournalName)
	_, oldErr := os.Stat(current)
	hadOld := oldErr == nil
	if oldErr != nil && !os.IsNotExist(oldErr) {
		return fmt.Errorf("checking current plugin: %w", oldErr)
	}
	if err := writePluginJournal(journal, pluginPromotionJournal{Candidate: candidate, Phase: "prepared", HadOld: hadOld}); err != nil {
		return err
	}
	if hadOld {
		if err := os.Rename(current, previous); err != nil {
			return fmt.Errorf("parking last known-good plugin: %w", err)
		}
	}
	if err := writePluginJournal(journal, pluginPromotionJournal{Candidate: candidate, Phase: "swapped", HadOld: hadOld}); err != nil {
		return rollbackPluginPromotion(runtimeDir, candidate, hadOld, err)
	}
	if err := os.Rename(candidate, current); err != nil {
		return rollbackPluginPromotion(runtimeDir, candidate, hadOld, fmt.Errorf("promoting plugin candidate: %w", err))
	}

	if err := install(current); err != nil {
		cause := fmt.Errorf("plugin candidate rejected: %w; last known-good preserved", err)
		rollbackErr := rollbackPluginPromotion(runtimeDir, current, hadOld, cause)
		if restore != nil {
			if restoreErr := restore(); restoreErr != nil {
				rollbackErr = fmt.Errorf("%w; restoring native installation: %v", rollbackErr, restoreErr)
			}
		}
		return rollbackErr
	}
	if err := writePluginJournal(journal, pluginPromotionJournal{Candidate: current, Phase: "committed", HadOld: hadOld}); err != nil {
		cause := fmt.Errorf("recording committed plugin promotion: %w; last known-good preserved", err)
		rollbackErr := rollbackPluginPromotion(runtimeDir, current, hadOld, cause)
		if restore != nil {
			if restoreErr := restore(); restoreErr != nil {
				rollbackErr = fmt.Errorf("%w; restoring native installation: %v", rollbackErr, restoreErr)
			}
		}
		return rollbackErr
	}
	if hadOld {
		_ = os.RemoveAll(previous)
	}
	_ = os.Remove(journal)
	return nil
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
		}
	} else {
		_ = os.RemoveAll(current)
	}
	if journal.Candidate != "" && journal.Candidate != current {
		_ = os.RemoveAll(journal.Candidate)
	}
	_ = os.Remove(journalPath)
	return nil
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
	return nil
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
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(link, target)
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
		closeErr := out.Close()
		if copyErr != nil {
			return copyErr
		}
		return closeErr
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

// withStagedPluginCandidate extends the existing CLI installers. Remote refs
// remain owned by the native CLI; local checkouts use the transactional source
// path so setup and update share exactly one promotion implementation.
func withStagedPluginCandidate(source string, install func(string) error) error {
	return withStagedPluginCandidateWithRestore(source, install, nil)
}

func withStagedPluginCandidateWithRestore(source string, install func(string) error, restore func() error) error {
	if !isLocalPath(source) {
		// Remote refs are fetched by the native CLI, so felt cannot pre-copy the
		// payload. Still probe the executable contract and restore the native
		// registration if the CLI mutates it before reporting a failure.
		executable, err := currentFeltExecutable()
		if err != nil {
			return err
		}
		if err := validateFeltExecutable(executable); err != nil {
			return err
		}
		err = install(source)
		if err != nil && restore != nil {
			if restoreErr := restore(); restoreErr != nil {
				return fmt.Errorf("%w; restoring native installation: %v", err, restoreErr)
			}
		}
		return err
	}
	if !hasMarketplaceManifest(source) {
		// Preserve the existing CLI error for a path that is only meaningful to
		// a test double or an older marketplace implementation; a real local
		// checkout with a manifest takes the staged path below.
		return install(source)
	}
	executable, err := currentFeltExecutable()
	if err != nil {
		return err
	}
	candidate, err := stagePluginCandidate(source, executable)
	if err != nil {
		return err
	}
	return promotePluginCandidate(candidate, install, restore)
}
