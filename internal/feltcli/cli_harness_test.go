package feltcli

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv"
	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
)

// testEnv is an isolated environment for one test: the fenced process
// environment (see TestMain) with HOME and the XDG cache and config homes
// pointed at fresh directories of its own, and captured streams. A test
// configures it with Set, Chdir and sysenvtest.FakeCommand, never by touching
// the process.
func testEnv(t *testing.T) (*sysenv.Env, *sysenvtest.Streams) {
	t.Helper()
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	return sysenvtest.FromProcess(t, map[string]string{
		"HOME":            home,
		"XDG_CACHE_HOME":  filepath.Join(dir, "cache"),
		"XDG_CONFIG_HOME": filepath.Join(dir, "config"),
	})
}

// testApp is one invocation bound to env, for a test that calls a command's
// helper directly instead of through a command line.
func testApp(t *testing.T, env *sysenv.Env) *app {
	t.Helper()
	return newApp(env)
}

// homeOf is env's HOME.
func homeOf(t *testing.T, env *sysenv.Env) string {
	t.Helper()
	home, err := env.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	return home
}

// fakeCommand is sysenvtest.FakeCommand with each distinct script written
// once per test binary and linked into env's bin. macOS assesses every new
// executable file on its first exec — about half a second, queued
// machine-wide, so dozens of fresh fakes in parallel tests cost seconds each
// — and a link to a file it has already assessed skips that. A fake reads
// anything test-specific (a log path, a state directory) from env.
func fakeCommand(t *testing.T, env *sysenv.Env, name, script string) string {
	t.Helper()
	path := filepath.Join(sysenvtest.FakeBin(t, env), name)
	linkScript(t, path, script)
	return path
}

// linkScript makes path a link to the shared, read-only file holding script
// (run under /bin/sh when it has no "#!" line), replacing whatever is there.
func linkScript(t *testing.T, path, script string) {
	t.Helper()
	if !strings.HasPrefix(script, "#!") {
		script = "#!/bin/sh\n" + script
	}
	shared := sharedScript(t, script)
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		t.Fatal(err)
	}
	if err := os.Symlink(shared, path); err != nil {
		t.Fatal(err)
	}
}

var sharedScripts struct {
	sync.Mutex
	paths map[string]string // script → file
}

func sharedScript(t *testing.T, script string) string {
	t.Helper()
	sharedScripts.Lock()
	defer sharedScripts.Unlock()
	if path, ok := sharedScripts.paths[script]; ok {
		return path
	}
	dir := filepath.Join(testScratch, "fakes")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(script))
	path := filepath.Join(dir, hex.EncodeToString(sum[:12]))
	// Read-only, so a write through one test's link fails loudly instead of
	// changing every other test's fake.
	if err := os.WriteFile(path, []byte(script), 0o555); err != nil {
		t.Fatal(err)
	}
	if sharedScripts.paths == nil {
		sharedScripts.paths = map[string]string{}
	}
	sharedScripts.paths[script] = path
	return path
}

// fakeCallLog fakes name first on env's PATH with a script that appends each
// invocation's arguments, one line per call, to a log and then runs body
// (exiting 0 unless body exits first). It returns a reader of the log.
func fakeCallLog(t *testing.T, env *sysenv.Env, name, body string) func() string {
	t.Helper()
	log := filepath.Join(t.TempDir(), name+"-calls.log")
	env.Set("FAKE_CALL_LOG_"+name, log)
	fakeCommand(t, env, name, "echo \"$@\" >> \"$FAKE_CALL_LOG_"+name+"\"\n"+body+"exit 0\n")
	return func() string {
		b, _ := os.ReadFile(log)
		return string(b)
	}
}

// executeCLI runs one `felt …` invocation in-process against dir, on a fresh
// isolated environment, and returns what it wrote to stdout and stderr.
func executeCLI(t *testing.T, dir string, args ...string) (stdout, stderr string, err error) {
	t.Helper()
	env, _ := testEnv(t)
	return executeIn(t, env, dir, args...)
}

// executeIn runs one `felt …` invocation against dir in a copy of env, so
// the invocation's output is its own and env stays unchanged for the next
// one. Each run builds a fresh command tree: no flag value, persistent or
// not, survives from one invocation to the next.
func executeIn(t *testing.T, env *sysenv.Env, dir string, args ...string) (stdout, stderr string, err error) {
	t.Helper()
	run := env.Clone()
	streams := sysenvtest.Capture(run)
	run.Stdin = env.Stdin
	a := newApp(run)
	root := a.rootCmd()
	a.dir = dir
	root.SetArgs(append([]string{}, args...))
	err = root.Execute()
	return streams.Stdout.String(), streams.Stderr.String(), err
}

// runCommand runs one `felt …` invocation against dir and returns its stdout
// (see executeCLI).
func runCommand(t *testing.T, dir string, args ...string) (string, error) {
	t.Helper()
	stdout, _, err := executeCLI(t, dir, args...)
	return stdout, err
}

// TestUsageOnlyForCommandLineErrors: a command that fails at run time prints
// its error, not the usage block — edit, add and sync included; a command
// line cobra cannot parse still gets usage.
func TestUsageOnlyForCommandLineErrors(t *testing.T) {
	t.Parallel()
	dir, _ := newStore(t)
	for _, args := range [][]string{
		{"edit", "nowhere", "-s", "open"},
		{"add", "x", "X", "-s", "bogus"},
		{"sync"}, // the fixture store is not a git repository
	} {
		stdout, stderr, err := executeCLI(t, dir, args...)
		if err == nil {
			t.Fatalf("%v: expected a run-time failure", args)
		}
		if strings.Contains(stdout+stderr, "Usage:") {
			t.Fatalf("%v printed usage for a run-time error:\n%s%s", args, stdout, stderr)
		}
	}
	for _, args := range [][]string{
		{"edit", "x", "--no-such-flag"},
	} {
		stdout, stderr, err := executeCLI(t, dir, args...)
		if err == nil || !strings.Contains(stdout+stderr, "Usage:") {
			t.Fatalf("%v: a command-line error should show usage: err=%v\n%s%s", args, err, stdout, stderr)
		}
	}
}

// TestFlagsDoNotLeakAcrossInvocations: a flag passed to one invocation is
// absent from the next — a scalar, a repeatable slice flag, and the root's
// persistent --json alike. Each invocation builds its own command tree, so this
// holds by construction; the test guards against a flag variable creeping back
// to package level.
func TestFlagsDoNotLeakAcrossInvocations(t *testing.T) {
	t.Parallel()
	dir, storage := newStore(t)

	if out, err := runCommand(t, dir, "add", "first", "First", "-t", "alpha", "-s", "active", "--json"); err != nil {
		t.Fatalf("add first: %v\n%s", err, out)
	}
	out, err := runCommand(t, dir, "add", "second", "Second")
	if err != nil {
		t.Fatalf("add second: %v\n%s", err, out)
	}
	if strings.HasPrefix(strings.TrimSpace(out), "{") {
		t.Fatalf("--json leaked into the next invocation: %s", out)
	}
	second, err := storage.Read("second")
	if err != nil {
		t.Fatalf("read second: %v", err)
	}
	if len(second.Tags) != 0 || second.Status != "" {
		t.Fatalf("flags leaked into the next invocation: tags=%v status=%q", second.Tags, second.Status)
	}

	// A repeatable flag starts empty each time, rather than appending.
	if out, err := runCommand(t, dir, "add", "third", "Third", "-t", "beta"); err != nil {
		t.Fatalf("add third: %v\n%s", err, out)
	}
	third, err := storage.Read("third")
	if err != nil {
		t.Fatalf("read third: %v", err)
	}
	if len(third.Tags) != 1 || third.Tags[0] != "beta" {
		t.Fatalf("third tags = %v, want [beta]", third.Tags)
	}
}
