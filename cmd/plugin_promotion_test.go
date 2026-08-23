package cmd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestPluginPromotionLockSerializesTransactions(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	var active int32
	var maxActive int32
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := withPluginPromotionLock(func() error {
				current := atomic.AddInt32(&active, 1)
				for {
					maximum := atomic.LoadInt32(&maxActive)
					if current <= maximum || atomic.CompareAndSwapInt32(&maxActive, maximum, current) {
						break
					}
				}
				time.Sleep(10 * time.Millisecond)
				atomic.AddInt32(&active, -1)
				return nil
			}); err != nil {
				t.Errorf("withPluginPromotionLock: %v", err)
			}
		}()
	}
	wg.Wait()
	if got := atomic.LoadInt32(&maxActive); got != 1 {
		t.Fatalf("maximum concurrent promotions = %d, want 1", got)
	}
}

func TestRestoreCodexInstallationRemovesCandidateBeforeAddingPrevious(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "calls.log")
	script := `#!/bin/sh
printf '%s\n' "$*" >> "$CODEX_TEST_LOG"
exit 0
`
	if err := os.WriteFile(filepath.Join(dir, "codex"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_TEST_LOG", logPath)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	err := restoreCodexInstallation(codexInstallationState{
		Source:     "/last-known-good",
		Configured: true,
		Installed:  false,
	})
	if err != nil {
		t.Fatalf("restoreCodexInstallation: %v", err)
	}
	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	want := "plugin marketplace remove " + marketplaceName + "\n" +
		"plugin marketplace add /last-known-good\n" +
		"plugin remove " + codexPluginRef + "\n"
	if string(data) != want {
		t.Fatalf("restore command order:\n%s\nwant:\n%s", data, want)
	}
}

func testContractExecutable(t *testing.T, level string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "felt")
	content := "#!/bin/sh\n[ \"$1\" = shuttle ] && [ \"$2\" = contract ] || exit 1\nprintf '%s\\n' " + level + "\n"
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func testRepoRoot(t *testing.T) string {
	t.Helper()
	root, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, statErr := os.Stat(filepath.Join(root, ".claude-plugin", "marketplace.json")); statErr == nil {
			return root
		}
		parent := filepath.Dir(root)
		if parent == root {
			t.Fatal("repository root not found")
		}
		root = parent
	}
}

func TestValidatePluginCandidateChecksGenerationAndContract(t *testing.T) {
	root := testRepoRoot(t)
	if err := validatePluginCandidate(root, testContractExecutable(t, "2")); err != nil {
		t.Fatalf("repository candidate should validate: %v", err)
	}

	bad := filepath.Join(t.TempDir(), "felt")
	for _, name := range []string{".claude-plugin", "claude-plugin"} {
		if err := copyTree(filepath.Join(root, name), filepath.Join(bad, name)); err != nil {
			t.Fatal(err)
		}
	}
	manifestPath := filepath.Join(bad, "claude-plugin", ".codex-plugin", "plugin.json")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	var manifest map[string]interface{}
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest["version"] = "mismatched"
	data, _ = json.Marshal(manifest)
	if err := os.WriteFile(manifestPath, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := validatePluginCandidate(bad, testContractExecutable(t, "2")); err == nil || !strings.Contains(err.Error(), "versions disagree") {
		t.Fatalf("version skew should be rejected, got %v", err)
	}
	if err := validatePluginCandidate(root, testContractExecutable(t, "1")); err == nil || !strings.Contains(err.Error(), "contract") {
		t.Fatalf("contract skew should be rejected, got %v", err)
	}
}

func TestCaptureNativeInstallationUsesCurrentCLIJSONShapes(t *testing.T) {
	if got := claudeMarketplaceSource(claudeMarketplaceEntry{Source: "github", Repo: "cailmdaley/felt"}); got != "cailmdaley/felt" {
		t.Fatalf("Claude github rollback source = %q", got)
	}

	dir := t.TempDir()
	codex := filepath.Join(dir, "codex")
	script := `#!/bin/sh
if [ "$1" = plugin ] && [ "$2" = marketplace ]; then
  printf '%s\n' '{"marketplaces":[{"name":"cailmdaley-felt","root":"/tmp/felt-current","marketplaceSource":{"sourceType":"github","source":"cailmdaley/felt"}}]}'
elif [ "$1" = plugin ] && [ "$2" = list ]; then
  printf '%s\n' '{"installed":[{"pluginId":"felt@cailmdaley-felt"}]}'
else
  exit 1
fi
`
	if err := os.WriteFile(codex, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	state := captureCodexInstallation()
	if !state.Configured || state.Source != "cailmdaley/felt" || !state.Installed {
		t.Fatalf("Codex state = %#v, want github source + installed plugin", state)
	}
}

func TestStagePluginCandidateCopiesOnlyValidatedPayload(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	root := testRepoRoot(t)
	candidate, err := stagePluginCandidate(root, testContractExecutable(t, "2"))
	if err != nil {
		t.Fatalf("stagePluginCandidate: %v", err)
	}
	if filepath.Dir(candidate) != filepath.Join(home, ".felt", pluginRuntimeDirName) {
		t.Fatalf("candidate staged outside runtime dir: %s", candidate)
	}
	if _, err := os.Stat(filepath.Join(candidate, ".git")); !os.IsNotExist(err) {
		t.Fatalf("staged candidate copied unrelated .git: %v", err)
	}
	if err := validatePluginCandidate(candidate, ""); err != nil {
		t.Fatalf("staged candidate invalid: %v", err)
	}
}

func TestPromotePluginCandidateRollsBackOnInstallerFailure(t *testing.T) {
	runtimeDir := t.TempDir()
	current := filepath.Join(runtimeDir, pluginCurrentName)
	if err := os.MkdirAll(current, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(current, "generation"), []byte("good"), 0o644); err != nil {
		t.Fatal(err)
	}
	candidate := filepath.Join(runtimeDir, ".candidate")
	if err := os.MkdirAll(candidate, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(candidate, "generation"), []byte("bad"), 0o644); err != nil {
		t.Fatal(err)
	}
	err := promotePluginCandidate(candidate, func(string) error { return os.ErrPermission }, nil)
	if err == nil || !strings.Contains(err.Error(), "last known-good preserved") {
		t.Fatalf("expected rollback error, got %v", err)
	}
	data, readErr := os.ReadFile(filepath.Join(current, "generation"))
	if readErr != nil || string(data) != "good" {
		t.Fatalf("last known-good was not restored: %q (%v)", data, readErr)
	}
	if _, err := os.Stat(filepath.Join(runtimeDir, pluginPreviousName)); !os.IsNotExist(err) {
		t.Fatalf("previous copy remained after rollback: %v", err)
	}
	if _, err := os.Stat(filepath.Join(runtimeDir, pluginJournalName)); !os.IsNotExist(err) {
		t.Fatalf("promotion journal remained after rollback: %v", err)
	}
}

func TestPromotePluginCandidateRestoresNativeStateBeforeReturningFailure(t *testing.T) {
	runtimeDir := t.TempDir()
	current := filepath.Join(runtimeDir, pluginCurrentName)
	if err := os.MkdirAll(current, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(current, "generation"), []byte("good"), 0o644); err != nil {
		t.Fatal(err)
	}
	candidate := filepath.Join(runtimeDir, ".candidate")
	if err := os.MkdirAll(candidate, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(candidate, "generation"), []byte("bad"), 0o644); err != nil {
		t.Fatal(err)
	}
	nativeGeneration := "good"
	err := promotePluginCandidate(candidate, func(string) error {
		nativeGeneration = "bad"
		return os.ErrPermission
	}, func() error {
		data, readErr := os.ReadFile(filepath.Join(runtimeDir, pluginCurrentName, "generation"))
		if readErr != nil {
			return readErr
		}
		nativeGeneration = string(data)
		return nil
	})
	if err == nil || nativeGeneration != "good" {
		t.Fatalf("native state = %q after failed promotion (%v), want good", nativeGeneration, err)
	}
}

func TestPromotePluginCandidateIsRepeatable(t *testing.T) {
	runtimeDir := t.TempDir()
	for _, generation := range []string{"one", "two"} {
		candidate := filepath.Join(runtimeDir, ".candidate-"+generation)
		if err := os.MkdirAll(candidate, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(candidate, "generation"), []byte(generation), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := promotePluginCandidate(candidate, func(active string) error {
			_, err := os.Stat(filepath.Join(active, "generation"))
			return err
		}, nil); err != nil {
			t.Fatalf("promotion %s: %v", generation, err)
		}
		data, err := os.ReadFile(filepath.Join(runtimeDir, pluginCurrentName, "generation"))
		if err != nil || string(data) != generation {
			t.Fatalf("active generation = %q (%v), want %q", data, err, generation)
		}
	}
}

func TestRecoverPluginPromotionPrefersLastKnownGoodAfterInterruption(t *testing.T) {
	runtimeDir := t.TempDir()
	current := filepath.Join(runtimeDir, pluginCurrentName)
	previous := filepath.Join(runtimeDir, pluginPreviousName)
	if err := os.MkdirAll(current, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(previous, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(current, "generation"), []byte("candidate"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(previous, "generation"), []byte("good"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writePluginJournal(filepath.Join(runtimeDir, pluginJournalName), pluginPromotionJournal{
		Candidate: current,
		Phase:     "swapped",
		HadOld:    true,
	}); err != nil {
		t.Fatal(err)
	}
	if err := recoverPluginPromotion(runtimeDir); err != nil {
		t.Fatalf("recovery: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(current, "generation"))
	if err != nil || string(data) != "good" {
		t.Fatalf("recovered generation = %q (%v), want good", data, err)
	}
	if _, err := os.Stat(filepath.Join(runtimeDir, pluginJournalName)); !os.IsNotExist(err) {
		t.Fatalf("journal remained after recovery: %v", err)
	}
}
