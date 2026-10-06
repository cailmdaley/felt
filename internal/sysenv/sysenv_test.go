package sysenv

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func writeExecutable(t *testing.T, dir, name, body string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestIsolatedEnvReadsOnlyItsOwnState(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	env := New(dir, []string{"HOME=/fake/home", "ONLY_HERE=1", "malformed", "=nokey"})

	if got := env.Getenv("ONLY_HERE"); got != "1" {
		t.Fatalf("Getenv = %q", got)
	}
	if _, ok := env.LookupEnv("PATH"); ok {
		t.Fatal("an isolated env inherited the process PATH")
	}
	if home, err := env.UserHomeDir(); err != nil || home != "/fake/home" {
		t.Fatalf("UserHomeDir = %q, %v", home, err)
	}
	if wd, err := env.Getwd(); err != nil || wd != dir {
		t.Fatalf("Getwd = %q, %v", wd, err)
	}
	if abs, _ := env.Abs("a/b"); abs != filepath.Join(dir, "a", "b") {
		t.Fatalf("Abs = %q", abs)
	}
	if got := strings.Join(env.Environ(), " "); got != "HOME=/fake/home ONLY_HERE=1" {
		t.Fatalf("Environ = %q", got)
	}

	env.Unset("HOME")
	if _, err := env.UserHomeDir(); err == nil {
		t.Fatal("UserHomeDir without HOME should fail, as os.UserHomeDir does")
	}
}

func TestCloneIsIndependent(t *testing.T) {
	t.Parallel()
	base := New("/a", []string{"K=base"})
	clone := base.Clone()
	clone.Set("K", "clone")
	clone.Chdir("/b")
	if base.Getenv("K") != "base" {
		t.Fatal("Set on a clone reached its source")
	}
	if wd, _ := base.Getwd(); wd != "/a" {
		t.Fatalf("Chdir on a clone reached its source: %q", wd)
	}
	clone.Chdir("c")
	if wd, _ := clone.Getwd(); wd != "/b/c" {
		t.Fatalf("relative Chdir = %q", wd)
	}
}

func TestLiveEnvRefusesWrites(t *testing.T) {
	t.Parallel()
	defer func() {
		if recover() == nil {
			t.Fatal("Set on the live env did not panic")
		}
	}()
	OS().Set("SYSENV_NEVER", "1")
}

func TestLookPathSearchesTheInjectedPath(t *testing.T) {
	t.Parallel()
	bin := t.TempDir()
	tool := writeExecutable(t, bin, "sysenv-fake-tool", "#!/bin/sh\necho hi\n")
	writeExecutable(t, bin, "not-executable", "")
	if err := os.Chmod(filepath.Join(bin, "not-executable"), 0o644); err != nil {
		t.Fatal(err)
	}

	env := New(t.TempDir(), []string{"PATH=" + bin})
	if got, err := env.LookPath("sysenv-fake-tool"); err != nil || got != tool {
		t.Fatalf("LookPath = %q, %v", got, err)
	}
	if _, err := env.LookPath("not-executable"); !errors.Is(err, exec.ErrNotFound) {
		t.Fatalf("a non-executable file was found: %v", err)
	}
	if _, err := OS().LookPath("sysenv-fake-tool"); err == nil {
		t.Fatal("the process PATH saw the injected tool")
	}
	if got, err := env.LookPath(tool); err != nil || got != tool {
		t.Fatalf("LookPath(absolute) = %q, %v", got, err)
	}
}

func TestCommandRunsInsideTheEnv(t *testing.T) {
	t.Parallel()
	bin := t.TempDir()
	writeExecutable(t, bin, "sysenv-print", "#!/bin/sh\nprintf '%s|%s|%s' \"$MARK\" \"$PWD\" \"$(pwd -P)\"\n")
	work, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	env := New(work, []string{"PATH=" + bin + ":/usr/bin:/bin", "MARK=isolated"})

	var out bytes.Buffer
	cmd := env.Command("sysenv-print")
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		t.Fatalf("run: %v", err)
	}
	if got := out.String(); !strings.HasPrefix(got, "isolated|") || !strings.HasSuffix(got, "|"+work) {
		t.Fatalf("child saw %q, want MARK=isolated and cwd %s", got, work)
	}

	missing := env.Command("sysenv-no-such-tool")
	if !errors.Is(missing.Run(), exec.ErrNotFound) {
		t.Fatal("a command missing from the injected PATH ran")
	}
}
