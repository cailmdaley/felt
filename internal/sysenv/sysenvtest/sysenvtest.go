// Package sysenvtest builds isolated sysenv environments for tests: fake
// executables on an injected PATH and captured standard streams, so a test
// that fakes `claude` or `git` can run in parallel with every other test in
// its process.
package sysenvtest

import (
	"bytes"
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
// It returns the executable's path. A script with no "#!" line runs under
// /bin/sh.
func FakeCommand(t testing.TB, env *sysenv.Env, name, script string) string {
	t.Helper()
	bin := FakeBin(t, env)
	if !strings.HasPrefix(script, "#!") {
		script = "#!/bin/sh\n" + script
	}
	path := filepath.Join(bin, name)
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("writing fake %s: %v", name, err)
	}
	return path
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
