package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func await(t *testing.T, description string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", description)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestLockWaitsNamesHolderAndSurvivesKilledDeployer(t *testing.T) {
	root := t.TempDir()
	binary := filepath.Join(root, "deploy-lock")
	if out, err := exec.Command("go", "build", "-o", binary, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, out)
	}
	host, lease := filepath.Join(root, "host.lock"), filepath.Join(root, "tree.lock")
	gate := filepath.Join(root, "gate")
	if err := syscall.Mkfifo(gate, 0600); err != nil {
		t.Fatal(err)
	}
	entered, finished := filepath.Join(root, "entered"), filepath.Join(root, "finished")
	logPath := filepath.Join(root, "log")
	log, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	first := exec.Command(binary, host, lease, "host=fake target=aaa deployer=first", "bash", "-c", `echo entered > "$1"; read -r line < "$2"`, "transaction", entered, gate)
	first.Stdout, first.Stderr = log, log
	first.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := first.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = syscall.Kill(-first.Process.Pid, syscall.SIGKILL) })
	await(t, "first transaction", func() bool { _, err := os.Stat(entered); return err == nil })
	startSecond := func() *exec.Cmd {
		command := exec.Command(binary, host, lease, "host=fake target=bbb deployer=second", "bash", "-c", `echo finished > "$1"; exit 7`, "transaction", finished)
		command.Stdout, command.Stderr = log, log
		if err := command.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if command.ProcessState == nil {
				_ = command.Process.Kill()
				_ = command.Wait()
			}
		})
		return command
	}
	second := startSecond()
	await(t, "holder diagnostic", func() bool {
		b, _ := os.ReadFile(logPath)
		return strings.Contains(string(b), "waiting for") && strings.Contains(string(b), "holder: host=fake target=aaa deployer=first")
	})
	// Remove the waiter before probing the crashed holder's inherited lock,
	// so a newly acquired second lock cannot mask a missing inheritance.
	if err := second.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = second.Wait()
	if err := first.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = first.Wait()
	// The build's inherited descriptors, not the controller's PID, own the locks.
	for _, path := range []string{host, lease} {
		probe, err := os.OpenFile(path, os.O_RDWR, 0600)
		if err != nil {
			t.Fatal(err)
		}
		err = syscall.Flock(int(probe.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		probe.Close()
		if err != syscall.EWOULDBLOCK {
			t.Fatalf("crash dropped live transaction lock %s: %v", path, err)
		}
	}
	second = startSecond()
	if _, err := os.Stat(finished); !os.IsNotExist(err) {
		t.Fatalf("second transaction overlapped first: %v", err)
	}
	unblock, err := os.OpenFile(gate, os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = unblock.WriteString("continue\n")
	unblock.Close()
	err = second.Wait()
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 7 {
		t.Fatalf("child exit status=%v, want 7", err)
	}
	if _, err := os.Stat(finished); err != nil {
		t.Fatal(err)
	}
	// A dead transaction needs no timeout or stale-lock deletion to recover.
	if out, err := exec.Command(binary, host, lease, "third", "bash", "-c", ":").CombinedOutput(); err != nil {
		t.Fatalf("recover: %v %s", err, out)
	}
}
