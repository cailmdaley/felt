package feltcli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

func TestPluginPromotionLockSerializesTransactions(t *testing.T) {
	t.Parallel()
	env, _ := testEnv(t)
	a := testApp(t, env)
	var active int32
	var maxActive int32
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := a.withPluginPromotionLock(func() error {
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
	t.Parallel()
	env, _ := testEnv(t)
	calls := fakeCallLog(t, env, "codex", "")

	err := testApp(t, env).restoreCodexInstallation(codexInstallationState{
		Source:     "/last-known-good",
		Configured: true,
		Installed:  false,
	})
	if err != nil {
		t.Fatalf("restoreCodexInstallation: %v", err)
	}
	data := calls()
	want := "plugin marketplace remove " + marketplaceName + "\n" +
		"plugin marketplace add /last-known-good\n" +
		"plugin remove " + codexPluginRef + "\n"
	if string(data) != want {
		t.Fatalf("restore command order:\n%s\nwant:\n%s", data, want)
	}
}

func testFeltExecutable(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "felt")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestValidatePluginCandidateChecksGenerationAndExecutable(t *testing.T) {
	t.Parallel()
	root := repoRoot(t)
	if err := validatePluginCandidate(root, testFeltExecutable(t)); err != nil {
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
	if err := validatePluginCandidate(bad, testFeltExecutable(t)); err == nil || !strings.Contains(err.Error(), "versions disagree") {
		t.Fatalf("version skew should be rejected, got %v", err)
	}
	if err := validatePluginCandidate(root, filepath.Join(t.TempDir(), "missing")); err == nil || !strings.Contains(err.Error(), "felt executable") {
		t.Fatalf("missing felt executable should be rejected, got %v", err)
	}
}

func TestCaptureNativeInstallationUsesCurrentCLIJSONShapes(t *testing.T) {
	t.Parallel()
	if got := claudeMarketplaceSource(claudeMarketplaceEntry{Source: "github", Repo: "cailmdaley/felt"}); got != "cailmdaley/felt" {
		t.Fatalf("Claude github rollback source = %q", got)
	}

	env, _ := testEnv(t)
	fakeCommand(t, env, "codex", `if [ "$1" = plugin ] && [ "$2" = marketplace ]; then
  printf '%s\n' '{"marketplaces":[{"name":"cailmdaley-felt","root":"/tmp/felt-current","marketplaceSource":{"sourceType":"github","source":"cailmdaley/felt"}}]}'
elif [ "$1" = plugin ] && [ "$2" = list ]; then
  printf '%s\n' '{"installed":[{"pluginId":"felt@cailmdaley-felt"}]}'
else
  exit 1
fi
`)
	state := testApp(t, env).captureCodexInstallation()
	if !state.Configured || state.Source != "cailmdaley/felt" || !state.Installed {
		t.Fatalf("Codex state = %#v, want github source + installed plugin", state)
	}
}

func TestStagePluginCandidateCopiesOnlyValidatedPayload(t *testing.T) {
	t.Parallel()
	env, _ := testEnv(t)
	home := homeOf(t, env)
	root := repoRoot(t)
	candidate, err := testApp(t, env).stagePluginCandidate(root, testFeltExecutable(t))
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

func TestCopyTreeRejectsSymlinkPayload(t *testing.T) {
	t.Parallel()
	source := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("not part of the candidate"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(source, "escape")); err != nil {
		t.Fatal(err)
	}
	err := copyTree(source, filepath.Join(t.TempDir(), "candidate"))
	if err == nil || !strings.Contains(err.Error(), "may not contain symlink") {
		t.Fatalf("copyTree symlink error = %v, want explicit refusal", err)
	}
}

func TestLocalPluginSourceWithoutManifestIsRejectedBeforeInstall(t *testing.T) {
	t.Parallel()
	env, _ := testEnv(t)
	env.Set("FELT_BIN", testFeltExecutable(t))
	called := false
	err := testApp(t, env).withStagedPluginCandidateWithRestore(t.TempDir(), func(string) error {
		called = true
		return nil
	}, nil)
	if err == nil || !strings.Contains(err.Error(), "has no marketplace manifest") {
		t.Fatalf("invalid local source error = %v, want manifest refusal", err)
	}
	if called {
		t.Fatal("native installer was called for an unvalidated local source")
	}
}

func TestPromotePluginCandidateRollsBackOnInstallerFailure(t *testing.T) {
	t.Parallel()
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
	env, _ := testEnv(t)
	err := testApp(t, env).promotePluginCandidate(candidate, func(string) error { return os.ErrPermission }, nil)
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
	t.Parallel()
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
	env, _ := testEnv(t)
	err := testApp(t, env).promotePluginCandidate(candidate, func(string) error {
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
	t.Parallel()
	runtimeDir := t.TempDir()
	env, _ := testEnv(t)
	a := testApp(t, env)
	for _, generation := range []string{"one", "two"} {
		candidate := filepath.Join(runtimeDir, ".candidate-"+generation)
		if err := os.MkdirAll(candidate, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(candidate, "generation"), []byte(generation), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := a.promotePluginCandidate(candidate, func(active string) error {
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
	t.Parallel()
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
	env, _ := testEnv(t)
	if err := testApp(t, env).recoverPluginPromotion(runtimeDir); err != nil {
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

func TestRecoverPluginPromotionRestoresFilesystemBeforeNativeReconciliation(t *testing.T) {
	t.Parallel()
	f := newRemoteSetupFixture(t, "claude")
	runtimeDir := filepath.Join(f.home, ".felt", pluginRuntimeDirName)
	current := filepath.Join(runtimeDir, pluginCurrentName)
	previous := filepath.Join(runtimeDir, pluginPreviousName)
	if err := os.MkdirAll(filepath.Join(current, "claude-plugin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(previous, "claude-plugin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(current, "generation.txt"), []byte("candidate"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(previous, "generation.txt"), []byte("good"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Native state has already been mutated to the interrupted candidate.
	if err := os.WriteFile(filepath.Join(f.stateDir, "source"), []byte(current), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.stateDir, "installed"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	intent := &claudeInstallationState{Marketplace: claudeMarketplaceEntry{Path: previous}, Configured: true, Installed: true}
	if err := writePluginJournal(filepath.Join(runtimeDir, pluginJournalName), pluginPromotionJournal{
		Candidate: current,
		Phase:     "swapped",
		HadOld:    true,
		Native:    &pluginNativeIntent{Claude: intent},
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.a.recoverPluginPromotion(runtimeDir); err != nil {
		t.Fatalf("recovery: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(current, "generation.txt"))
	if err != nil || string(data) != "good" {
		t.Fatalf("recovered generation = %q (%v), want good", data, err)
	}
	source, err := os.ReadFile(filepath.Join(f.stateDir, "source"))
	if err != nil || strings.TrimSpace(string(source)) != current {
		t.Fatalf("native source = %q (%v), want restored current %q", source, err, current)
	}
	if _, err := os.Stat(filepath.Join(runtimeDir, pluginJournalName)); !os.IsNotExist(err) {
		t.Fatalf("successful native reconciliation left journal: %v", err)
	}
}

func TestRecoverInitialClaudePromotionDoesNotRemoveAlreadyAbsentMarketplace(t *testing.T) {
	t.Parallel()
	f := newRemoteSetupFixture(t, "claude")
	f.env.Set("FAKE_CLAUDE_FAIL_ABSENT_REMOVE", "1")
	runtimeDir := filepath.Join(f.home, ".felt", pluginRuntimeDirName)
	current := filepath.Join(runtimeDir, pluginCurrentName)
	if err := os.MkdirAll(current, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := writePluginJournal(filepath.Join(runtimeDir, pluginJournalName), pluginPromotionJournal{
		Candidate: current,
		Phase:     "swapped",
		HadOld:    false,
		Native:    &pluginNativeIntent{Claude: &claudeInstallationState{}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.a.recoverPluginPromotion(runtimeDir); err != nil {
		t.Fatalf("already-absent recovery: %v", err)
	}
	if _, err := os.Stat(filepath.Join(runtimeDir, pluginJournalName)); !os.IsNotExist(err) {
		t.Fatalf("already-absent recovery left journal: %v", err)
	}
	log, err := os.ReadFile(f.nativeLog)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(log), "marketplace remove") {
		t.Fatalf("recovery tried to remove an already absent marketplace:\n%s", log)
	}
}

func TestInterruptedPromotionRecoveryPrecedesAcquisitionFailureAndRetry(t *testing.T) {
	t.Parallel()
	f := newRemoteSetupFixture(t, "claude")
	runtimeDir := filepath.Join(f.home, ".felt", pluginRuntimeDirName)
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
	if err := os.WriteFile(filepath.Join(f.stateDir, "source"), []byte(current), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.stateDir, "installed"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writePluginJournal(filepath.Join(runtimeDir, pluginJournalName), pluginPromotionJournal{
		Candidate: current,
		Phase:     "swapped",
		HadOld:    true,
		Native:    &pluginNativeIntent{Claude: &claudeInstallationState{Configured: true, Installed: true}},
	}); err != nil {
		t.Fatal(err)
	}

	root := repoRoot(t)
	installFakeGitForPluginAcquisition(t, f.env, root)
	f.env.Set("FELT_BIN", testFeltExecutable(t))
	f.env.Set("FELT_TEST_GIT_FAIL", "1")
	err := f.a.withStagedPluginCandidateWithRestore("cailmdaley/felt@missing", func(string) error {
		t.Fatal("native installer called after acquisition failure")
		return nil
	}, nil)
	if err == nil || !strings.Contains(err.Error(), "acquiring remote marketplace") {
		t.Fatalf("first retry error = %v, want acquisition failure after recovery", err)
	}
	if _, err := os.Stat(filepath.Join(runtimeDir, pluginJournalName)); !os.IsNotExist(err) {
		t.Fatalf("recovered journal remained after successful native reconciliation: %v", err)
	}
	if got, readErr := os.ReadFile(filepath.Join(current, "generation")); readErr != nil || string(got) != "good" {
		t.Fatalf("filesystem after acquisition failure = %q (%v), want good", got, readErr)
	}

	f.env.Set("FELT_TEST_GIT_FAIL", "0")
	called := false
	if err := f.a.withStagedPluginCandidateWithRestore("cailmdaley/felt@missing", func(active string) error {
		called = true
		return validatePluginCandidate(active, "")
	}, nil); err != nil {
		t.Fatalf("retry after acquisition failure: %v", err)
	}
	if !called {
		t.Fatal("native installer was not called on retry")
	}
}

func TestParseRemoteMarketplaceRef(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		input      string
		repository string
		ref        string
		wantErr    bool
	}{
		{name: "bare", input: "cailmdaley/felt", repository: "cailmdaley/felt"},
		{name: "claude tag", input: "cailmdaley/felt#v1.2.3", repository: "cailmdaley/felt", ref: "v1.2.3"},
		{name: "codex tag", input: "cailmdaley/felt@v1.2.3", repository: "cailmdaley/felt", ref: "v1.2.3"},
		{name: "branch", input: "cailmdaley/felt#release/next", repository: "cailmdaley/felt", ref: "release/next"},
		{name: "empty", input: "", wantErr: true},
		{name: "missing owner", input: "felt#main", wantErr: true},
		{name: "empty revision", input: "cailmdaley/felt@", wantErr: true},
		{name: "third path component", input: "cailmdaley/felt/plugins", wantErr: true},
		{name: "wrong repository", input: "someone/felt#main", wantErr: true},
		{name: "URL spelling", input: "https://github.com/cailmdaley/felt#main", wantErr: true},
		{name: "surrounding whitespace", input: " cailmdaley/felt#main", wantErr: true},
		{name: "multiple separators", input: "cailmdaley/felt#main@other", wantErr: true},
		{name: "traversal revision", input: "cailmdaley/felt#release/../main", wantErr: true},
		{name: "option revision", input: "cailmdaley/felt#--upload-pack=bad", wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			got, err := parseRemoteMarketplaceRef(test.input)
			if test.wantErr {
				if err == nil {
					t.Fatalf("parseRemoteMarketplaceRef(%q) succeeded, want error", test.input)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseRemoteMarketplaceRef(%q): %v", test.input, err)
			}
			if got.repository != test.repository || got.ref != test.ref {
				t.Fatalf("parsed ref = %#v, want repository=%q ref=%q", got, test.repository, test.ref)
			}
		})
	}
}

// installFakeGitForPluginAcquisition fakes git on env's PATH: a clone copies
// source's plugin payload, logged to $FELT_TEST_GIT_LOG, and fails when
// $FELT_TEST_GIT_FAIL is 1. It returns the log path.
func installFakeGitForPluginAcquisition(t *testing.T, env *sysenv.Env, source string) string {
	t.Helper()
	log := filepath.Join(t.TempDir(), "git.log")
	fakeCommand(t, env, "git", `#!/bin/sh
last=""
for arg do last="$arg"; done
printf '%s\n' "$*" >> "$FELT_TEST_GIT_LOG"
if [ "$1" = "-C" ] && [ "$3" = "rev-parse" ]; then
  printf '%s\n' 0123456789012345678901234567890123456789
  exit 0
fi
if [ "$FELT_TEST_GIT_FAIL" = "1" ]; then
  echo "synthetic git acquisition failure" >&2
  exit 17
fi
mkdir -p "$last"
cp -R "$FELT_TEST_GIT_SOURCE"/.claude-plugin "$last"/
cp -R "$FELT_TEST_GIT_SOURCE"/claude-plugin "$last"/
`)
	env.Set("FELT_TEST_GIT_SOURCE", source)
	env.Set("FELT_TEST_GIT_LOG", log)
	return log
}

func TestRemoteMarketplaceAcquisitionStagesAndPromotesRepeatably(t *testing.T) {
	t.Parallel()
	env, _ := testEnv(t)
	home := homeOf(t, env)
	a := testApp(t, env)
	root := repoRoot(t)
	gitLog := installFakeGitForPluginAcquisition(t, env, root)
	env.Set("FELT_BIN", testFeltExecutable(t))

	var seen []string
	install := func(active string) error {
		seen = append(seen, active)
		if !filepath.IsAbs(active) || filepath.Base(active) != pluginCurrentName {
			t.Fatalf("native installer received non-current path %q", active)
		}
		if err := validatePluginCandidate(active, ""); err != nil {
			t.Fatalf("native installer received unvalidated candidate: %v", err)
		}
		return nil
	}
	for i := 0; i < 2; i++ {
		if err := a.withStagedPluginCandidateWithRestore("cailmdaley/felt#v1.2.3", install, nil); err != nil {
			t.Fatalf("remote promotion %d: %v", i+1, err)
		}
	}
	if len(seen) != 2 || seen[0] != seen[1] {
		t.Fatalf("native installer paths = %#v, want two uses of current", seen)
	}
	runtimeDir := filepath.Join(home, ".felt", pluginRuntimeDirName)
	entries, err := filepath.Glob(filepath.Join(runtimeDir, pluginAcquirePrefix+"*"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("temporary acquisition checkout was not cleaned up: %v", entries)
	}
	log, err := os.ReadFile(gitLog)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(log)), "\n")
	if len(lines) != 4 || !strings.Contains(lines[0], "--branch=v1.2.3 -- https://github.com/cailmdaley/felt.git") || !strings.Contains(lines[1], "rev-parse --verify HEAD^{commit}") {
		t.Fatalf("git acquisition log = %q, want two pinned clones and resolved commits", string(log))
	}
	identity, err := validatePluginGeneration(filepath.Join(runtimeDir, pluginCurrentName, "claude-plugin"))
	if err != nil {
		t.Fatalf("promoted remote generation: %v", err)
	}
	if identity.SourceKind != "github" || identity.Source != marketplaceRepo || identity.RequestedRef != "v1.2.3" || identity.ResolvedCommit != "0123456789012345678901234567890123456789" {
		t.Fatalf("remote identity = %#v", identity)
	}
}

func TestRemoteMarketplaceAcquisitionFailureCleansUpAndDoesNotInstall(t *testing.T) {
	t.Parallel()
	env, _ := testEnv(t)
	home := homeOf(t, env)
	runtimeDir := filepath.Join(home, ".felt", pluginRuntimeDirName)
	stale := filepath.Join(runtimeDir, pluginAcquirePrefix+"interrupted")
	if err := os.MkdirAll(stale, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stale, "partial"), []byte("crash debris"), 0o644); err != nil {
		t.Fatal(err)
	}
	root := repoRoot(t)
	installFakeGitForPluginAcquisition(t, env, root)
	env.Set("FELT_TEST_GIT_FAIL", "1")
	env.Set("FELT_BIN", testFeltExecutable(t))
	called := false
	err := testApp(t, env).withStagedPluginCandidateWithRestore("cailmdaley/felt@missing", func(string) error {
		called = true
		return nil
	}, nil)
	if err == nil || !strings.Contains(err.Error(), "acquiring remote marketplace") || !strings.Contains(err.Error(), "synthetic git acquisition failure") {
		t.Fatalf("acquisition error = %v, want reported git failure", err)
	}
	if called {
		t.Fatal("native installer was called after acquisition failure")
	}
	entries, readErr := filepath.Glob(filepath.Join(runtimeDir, pluginAcquirePrefix+"*"))
	if readErr != nil {
		t.Fatal(readErr)
	}
	if len(entries) != 0 {
		t.Fatalf("failed acquisition left temporary checkout: %v", entries)
	}
}
