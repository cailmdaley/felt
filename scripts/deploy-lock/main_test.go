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
	if err := first.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = first.Process.Kill() })
	await(t, "first transaction", func() bool { _, err := os.Stat(entered); return err == nil })
	second := exec.Command(binary, host, lease, "host=fake target=bbb deployer=second", "bash", "-c", `echo finished > "$1"; exit 7`, "transaction", finished)
	second.Stdout, second.Stderr = log, log
	if err := second.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = second.Process.Kill() })
	await(t, "holder diagnostic", func() bool {
		b, _ := os.ReadFile(logPath)
		return strings.Contains(string(b), "waiting for") && strings.Contains(string(b), "holder: host=fake target=aaa deployer=first")
	})
	if err := first.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = first.Wait()
	// The build's inherited descriptors, not the controller's PID, own the locks.
	probe, err := os.OpenFile(host, os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer probe.Close()
	if err := syscall.Flock(int(probe.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != syscall.EWOULDBLOCK {
		t.Fatalf("crash dropped live transaction lock: %v", err)
	}
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
