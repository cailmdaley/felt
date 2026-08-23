package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// These tests deliberately exercise the setup entry points instead of the
// promotion primitives directly. A native CLI is allowed to own its cache,
// but it must never be handed a remote ref: felt has to acquire and validate
// the payload first, then give both harnesses the one promoted path.
type remoteSetupFixture struct {
	home      string
	bin       string
	gitLog    string
	nativeLog string
	stateDir  string
	failMark  string
	source    string
	remote    string
}

func newRemoteSetupFixture(t *testing.T, harness string) *remoteSetupFixture {
	t.Helper()
	root := t.TempDir()
	f := &remoteSetupFixture{
		home:      filepath.Join(root, "home"),
		bin:       filepath.Join(root, "bin"),
		gitLog:    filepath.Join(root, "git.log"),
		nativeLog: filepath.Join(root, "native.log"),
		stateDir:  filepath.Join(root, "native-state"),
		failMark:  filepath.Join(root, "fail-once"),
		remote:    "cailmdaley/felt",
	}
	if err := os.MkdirAll(f.bin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(f.home, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(f.stateDir, 0o755); err != nil {
		t.Fatal(err)
	}
	f.source = f.remotePayload(t, "one")
	writeExecutable(t, filepath.Join(f.bin, "felt"), `#!/bin/sh
if [ "$1" = shuttle ] && [ "$2" = contract ]; then
  printf '%s\n' 2
  exit 0
fi
exit 1
`)
	writeExecutable(t, filepath.Join(f.bin, "git"), `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_GIT_LOG"
is_clone=0
destination=""
for arg in "$@"; do
  if [ "$arg" = clone ]; then is_clone=1; fi
  destination="$arg"
done
if [ "$is_clone" = 1 ]; then
  mkdir -p "$destination"
  cp -R "$FAKE_GIT_SOURCE"/. "$destination"/
fi
`)
	if harness == "claude" {
		writeExecutable(t, filepath.Join(f.bin, "claude"), claudeSetupFake)
	} else {
		writeExecutable(t, filepath.Join(f.bin, "codex"), codexSetupFake)
	}
	t.Setenv("HOME", f.home)
	t.Setenv("PATH", f.bin+string(os.PathListSeparator)+"/usr/bin:/bin")
	t.Setenv("FELT_BIN", filepath.Join(f.bin, "felt"))
	t.Setenv("FAKE_GIT_LOG", f.gitLog)
	t.Setenv("FAKE_GIT_SOURCE", f.source)
	t.Setenv("FAKE_NATIVE_LOG", f.nativeLog)
	t.Setenv("FAKE_NATIVE_STATE", f.stateDir)
	t.Setenv("FAKE_NATIVE_FAIL_MARK", f.failMark)
	t.Setenv("FAKE_NATIVE_REMOTE", "cailmdaley/felt")
	return f
}

func (f *remoteSetupFixture) remotePayload(t *testing.T, generation string) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "checkout")
	sourceRoot := testRepoRoot(t)
	for _, name := range []string{".claude-plugin", "claude-plugin"} {
		if err := copyTree(filepath.Join(sourceRoot, name), filepath.Join(root, name)); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "claude-plugin", "generation.txt"), []byte(generation), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

func writeExecutable(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
}

const claudeSetupFake = `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_NATIVE_LOG"
source_file="$FAKE_NATIVE_STATE/source"
installed_file="$FAKE_NATIVE_STATE/installed"
if [ "$1" = plugin ] && [ "$2" = marketplace ] && [ "$3" = list ]; then
  if [ -f "$source_file" ]; then
    source=$(cat "$source_file")
    printf '[{"name":"cailmdaley-felt","source":"directory","path":"%s"}]\n' "$source"
  else
    printf '%s\n' '[]'
  fi
  exit 0
fi
if [ "$1" = plugin ] && [ "$2" = list ]; then
  if [ -f "$installed_file" ]; then
    printf '%s\n' '[{"id":"felt@cailmdaley-felt"}]'
  else
    printf '%s\n' '[]'
  fi
  exit 0
fi
if [ "$1" = plugin ] && [ "$2" = marketplace ] && [ "$3" = add ]; then
  case "$4" in *"$FAKE_NATIVE_REMOTE"*) echo 'remote ref reached Claude CLI' >&2; exit 91;; esac
  printf '%s\n' "$4" > "$source_file"
  exit 0
fi
if [ "$1" = plugin ] && [ "$2" = marketplace ] && [ "$3" = remove ]; then
  rm -f "$source_file"
  exit 0
fi
if [ "$1" = plugin ] && { [ "$2" = install ] || [ "$2" = update ]; }; then
  if [ "${FAKE_NATIVE_FAIL_ONCE:-0}" = 1 ] && [ "$2" = update ] && [ ! -f "$FAKE_NATIVE_FAIL_MARK" ]; then
    : > "$FAKE_NATIVE_FAIL_MARK"
    echo 'reported Claude plugin failure' >&2
    exit 92
  fi
  : > "$installed_file"
  exit 0
fi
if [ "$1" = plugin ] && [ "$2" = uninstall ]; then
  rm -f "$installed_file"
  exit 0
fi
exit 0
`

const codexSetupFake = `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_NATIVE_LOG"
source_file="$FAKE_NATIVE_STATE/source"
installed_file="$FAKE_NATIVE_STATE/installed"
if [ "$1" = plugin ] && [ "$2" = marketplace ] && [ "$3" = list ]; then
  if [ -f "$source_file" ]; then
    source=$(cat "$source_file")
    printf '{"marketplaces":[{"name":"cailmdaley-felt","root":"%s","marketplaceSource":{"sourceType":"directory","source":"%s"}}]}\n' "$source" "$source"
  else
    printf '%s\n' '{"marketplaces":[]}'
  fi
  exit 0
fi
if [ "$1" = plugin ] && [ "$2" = list ]; then
  if [ -f "$installed_file" ]; then
    printf '%s\n' '{"installed":[{"pluginId":"felt@cailmdaley-felt"}]}'
  else
    printf '%s\n' '{"installed":[]}'
  fi
  exit 0
fi
if [ "$1" = plugin ] && [ "$2" = marketplace ] && [ "$3" = add ]; then
  case "$4" in *"$FAKE_NATIVE_REMOTE"*) echo 'remote ref reached Codex CLI' >&2; exit 91;; esac
  printf '%s\n' "$4" > "$source_file"
  exit 0
fi
if [ "$1" = plugin ] && [ "$2" = marketplace ] && [ "$3" = remove ]; then
  rm -f "$source_file"
  exit 0
fi
if [ "$1" = plugin ] && [ "$2" = add ]; then
  if [ "${FAKE_NATIVE_FAIL_ONCE:-0}" = 1 ] && [ ! -f "$FAKE_NATIVE_FAIL_MARK" ]; then
    : > "$FAKE_NATIVE_FAIL_MARK"
    echo 'reported Codex plugin failure' >&2
    exit 92
  fi
  : > "$installed_file"
  exit 0
fi
if [ "$1" = plugin ] && [ "$2" = remove ]; then
  rm -f "$installed_file"
  exit 0
fi
exit 0
`

func (f *remoteSetupFixture) setGeneration(t *testing.T, generation string) {
	t.Helper()
	f.source = f.remotePayload(t, generation)
	t.Setenv("FAKE_GIT_SOURCE", f.source)
}

func (f *remoteSetupFixture) currentGeneration(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(f.home, ".felt", pluginRuntimeDirName, pluginCurrentName, "claude-plugin", "generation.txt"))
	if err != nil {
		t.Fatalf("read promoted generation: %v", err)
	}
	return string(data)
}

func (f *remoteSetupFixture) assertNativeUsesCurrent(t *testing.T) {
	t.Helper()
	data, err := os.ReadFile(f.nativeLog)
	if err != nil {
		t.Fatal(err)
	}
	current := filepath.Join(f.home, ".felt", pluginRuntimeDirName, pluginCurrentName)
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.Contains(line, "plugin marketplace add ") {
			continue
		}
		if !strings.Contains(line, current) {
			t.Errorf("native CLI was not given promoted current path: %q", line)
		}
		if strings.Contains(line, f.remote) || strings.Contains(line, "cailmdaley/felt@") {
			t.Errorf("native CLI received remote ref instead of current path: %q", line)
		}
	}
	source, err := os.ReadFile(filepath.Join(f.stateDir, "source"))
	if err != nil {
		t.Fatalf("read native marketplace source: %v", err)
	}
	if got, want := strings.TrimSpace(string(source)), filepath.Join(f.home, ".felt", pluginRuntimeDirName, pluginCurrentName); got != want {
		t.Fatalf("native marketplace source = %q, want promoted current %q", got, want)
	}
	gitData, err := os.ReadFile(f.gitLog)
	if err != nil {
		t.Fatalf("read fake git log: %v", err)
	}
	if got := strings.Count(string(gitData), "clone "); got < 3 {
		t.Fatalf("fake git acquisitions = %d, want at least 3 (initial, repeat, failure)", got)
	}
}

func TestRemoteClaudeSetupUsesValidatedPromotion(t *testing.T) {
	f := newRemoteSetupFixture(t, "claude")
	if err := installPluginViaCLI(f.remote); err != nil {
		t.Fatalf("first remote Claude setup: %v", err)
	}
	if got := f.currentGeneration(t); got != "one" {
		t.Fatalf("first promoted generation = %q, want one", got)
	}

	f.setGeneration(t, "two")
	if err := installPluginViaCLI(f.remote + "#second"); err != nil {
		t.Fatalf("repeated remote Claude setup: %v", err)
	}
	if got := f.currentGeneration(t); got != "two" {
		t.Fatalf("repeated promoted generation = %q, want two", got)
	}

	f.setGeneration(t, "failed")
	t.Setenv("FAKE_NATIVE_FAIL_ONCE", "1")
	if err := installPluginViaCLI(f.remote + "#failed"); err == nil || !strings.Contains(err.Error(), "last known-good preserved") {
		t.Fatalf("reported native failure = %v, want preserved-promotion error", err)
	}
	if got := f.currentGeneration(t); got != "two" {
		t.Fatalf("failed promotion replaced current generation with %q, want two", got)
	}
	if _, err := os.Stat(filepath.Join(f.stateDir, "installed")); err != nil {
		t.Fatalf("native Claude installation was not restored: %v", err)
	}
	f.assertNativeUsesCurrent(t)
}

func TestRemoteCodexSetupUsesValidatedPromotion(t *testing.T) {
	f := newRemoteSetupFixture(t, "codex")
	if err := installCodexPluginViaCLI(f.remote); err != nil {
		t.Fatalf("first remote Codex setup: %v", err)
	}
	if got := f.currentGeneration(t); got != "one" {
		t.Fatalf("first promoted generation = %q, want one", got)
	}

	f.setGeneration(t, "two")
	if err := installCodexPluginViaCLI(f.remote + "#second"); err != nil {
		t.Fatalf("repeated remote Codex setup: %v", err)
	}
	if got := f.currentGeneration(t); got != "two" {
		t.Fatalf("repeated promoted generation = %q, want two", got)
	}

	f.setGeneration(t, "failed")
	t.Setenv("FAKE_NATIVE_FAIL_ONCE", "1")
	if err := installCodexPluginViaCLI(f.remote + "#failed"); err == nil || !strings.Contains(err.Error(), "last known-good preserved") {
		t.Fatalf("reported native failure = %v, want preserved-promotion error", err)
	}
	if got := f.currentGeneration(t); got != "two" {
		t.Fatalf("failed promotion replaced current generation with %q, want two", got)
	}
	if _, err := os.Stat(filepath.Join(f.stateDir, "installed")); err != nil {
		t.Fatalf("native Codex installation was not restored: %v", err)
	}
	f.assertNativeUsesCurrent(t)
}
