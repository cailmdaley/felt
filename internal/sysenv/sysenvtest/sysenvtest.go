// Package sysenvtest builds isolated sysenv environments for tests: fake
// executables on an injected PATH and captured standard streams, so a test
// that fakes `claude` or `git` can run in parallel with every other test in
// its process.
package sysenvtest

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// FromProcess is an isolated copy of the test process's environment (its
// variables and working directory), with the overrides applied and captured
// streams. A package's TestMain fence has already scrubbed the process
// environment, so this is the fence as an injectable value; each test then
// points the machine-level paths it reads at directories of its own.
func FromProcess(t testing.TB, overrides map[string]string) (*sysenv.Env, *Streams) {
	t.Helper()
	env := sysenv.OS().Clone()
	for key, value := range overrides {
		env.Set(key, value)
	}
	return env, Capture(env)
}

// Streams holds the output an Env's command wrote.
type Streams struct {
	Stdout, Stderr *Buffer
}

// Capture points env's stdout and stderr at fresh buffers and its stdin at an
// empty reader.
func Capture(env *sysenv.Env) *Streams {
	s := &Streams{Stdout: &Buffer{}, Stderr: &Buffer{}}
	env.Stdin = strings.NewReader("")
	env.Stdout, env.Stderr = s.Stdout, s.Stderr
	return s
}

// Buffer is a bytes.Buffer safe for a command and its goroutines (or child
// process copiers) to write while the test reads it.
type Buffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *Buffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *Buffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// Reset empties the buffer.
func (b *Buffer) Reset() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.buf.Reset()
}

// FakeCommand writes an executable named name holding script into a bin
// directory private to env and puts that directory first on env's PATH, so
// env.LookPath and env.Command find it ahead of any real tool of that name.
// It returns the executable's path; the file is shared as LinkScript says.
func FakeCommand(t testing.TB, env *sysenv.Env, name, script string) string {
	t.Helper()
	path := filepath.Join(FakeBin(t, env), name)
	LinkScript(t, path, script)
	return path
}

// LinkScript makes path an executable holding script (run under /bin/sh when
// it has no "#!" line), replacing whatever is there. The file is a hard link
// to a read-only copy shared by every test that writes the same script, so a
// write through one test's link fails loudly instead of changing another's.
func LinkScript(t testing.TB, path, script string) {
	t.Helper()
	if !strings.HasPrefix(script, "#!") {
		script = "#!/bin/sh\n" + script
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		t.Fatal(err)
	}
	if source, err := cachedScript(script); err == nil && os.Link(source, path) == nil {
		return
	}
	if err := os.WriteFile(path, []byte(script), 0o555); err != nil {
		t.Fatalf("writing %s: %v", path, err)
	}
}

// cachedScript is a read-only executable holding script in a cache shared by
// every test run on this machine, named by its content's hash. LinkScript
// hard-links it into place: macOS assesses a new executable
// on its first exec (about a second on a loaded machine) and remembers the
// verdict for that file, so a script every test fakes is assessed once
// rather than once per test.
func cachedScript(script string) (string, error) {
	sum := sha256.Sum256([]byte(script))
	dir := filepath.Join(os.TempDir(), fmt.Sprintf("sysenvtest-%d", os.Getuid()))
	path := filepath.Join(dir, hex.EncodeToString(sum[:16]))
	if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
		return path, nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(dir, ".script-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(script); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Chmod(0o555); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return "", err
	}
	return path, nil
}

// fakeBins remembers each env's private bin directory.
var fakeBins sync.Map // *sysenv.Env → string

// FakeBin is env's private bin directory, created and put first on env's
// PATH on first use.
func FakeBin(t testing.TB, env *sysenv.Env) string {
	t.Helper()
	if dir, ok := fakeBins.Load(env); ok {
		return dir.(string)
	}
	dir := t.TempDir()
	if actual, loaded := fakeBins.LoadOrStore(env, dir); loaded {
		return actual.(string)
	}
	t.Cleanup(func() { fakeBins.Delete(env) })
	PrependPath(env, dir)
	return dir
}

// PrependPath puts dir first on env's PATH.
func PrependPath(env *sysenv.Env, dir string) {
	if path := env.Getenv("PATH"); path != "" {
		env.Set("PATH", dir+string(os.PathListSeparator)+path)
		return
	}
	env.Set("PATH", dir)
}

// OnlyPath replaces env's PATH with dirs plus the system directories a shell
// script needs (/usr/bin, /bin), keeping env's FakeBin first when it has one,
// so a test sees exactly the tools it faked.
func OnlyPath(env *sysenv.Env, dirs ...string) {
	if bin, ok := fakeBins.Load(env); ok {
		dirs = append([]string{bin.(string)}, dirs...)
	}
	env.Set("PATH", strings.Join(append(dirs, "/usr/bin", "/bin"), string(os.PathListSeparator)))
}
