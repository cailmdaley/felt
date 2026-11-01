package shuttlecli

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
)

func releaseLockHeld(home string) bool {
	file, err := os.OpenFile(filepath.Join(home, ".shuttle", "release.lock"), os.O_RDWR, 0600)
	if err != nil {
		return false
	}
	defer file.Close()
	err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if err == nil {
		syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
		return false
	}
	return err == syscall.EWOULDBLOCK || err == syscall.EAGAIN
}

func TestSelectionRevalidatesAfterWaitingForPruning(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	a := newApp(env)
	old := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "old"))
	next := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "next"))
	if err := a.selectDaemonRelease(old); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	if err := a.withReleaseLock(func() error {
		go func() { done <- a.selectDaemonRelease(next) }()
		return os.RemoveAll(next.Dir)
	}); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err == nil {
		t.Fatal("published a target removed by a concurrent prune")
	}
	pointer, _ := a.releasePointerPath()
	contents, _ := os.ReadFile(pointer)
	if string(contents) != old.Dir+"\n" {
		t.Fatalf("failed selection replaced old target: %q", contents)
	}
}

func TestReleaseLockCycleProbe(t *testing.T) {
	home := os.Getenv("SHUTTLE_TEST_RELEASE_LOCK_HOME")
	if home == "" {
		return
	}
	if !releaseLockHeld(home) {
		t.Fatal("activation released its selection lock before the cycle")
	}
}

func TestActivationSerializesSelectionWithCycle(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	home, _ := env.UserHomeDir()
	env.Set("SHUTTLE_TEST_RELEASE_LOCK_HOME", home)
	sysenvtest.FakeCommand(t, env, "tmux", "#!/bin/sh\nexit 1\n")
	release := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "release"))
	_, stderr, err := executeIn(t, env, t.TempDir(), "daemon", "activate-release", release.Dir, "--", os.Args[0], "-test.run=^TestReleaseLockCycleProbe$")
	if err != nil {
		t.Fatalf("activation: %v %s", err, stderr)
	}
	if releaseLockHeld(home) {
		t.Fatal("selection lock leaked after cycle")
	}
}
