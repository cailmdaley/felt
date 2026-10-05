package messaging

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// startReceiver runs a stand-in harness process for a mailbox registration.
func startReceiver(t *testing.T) *exec.Cmd {
	t.Helper()
	cmd := exec.Command("sleep", "60")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	})
	return cmd
}

func TestMailboxOfExitedReceiverLeavesDiscoveryAndRejects(t *testing.T) {
	env := testEnv(t)
	env.Set("SHUTTLE_DATA_DIR", t.TempDir())
	receiver := startReceiver(t)
	if err := RegisterMailbox(env, "codex", "old-worker", "host", "/project", receiver.Process.Pid, true); err != nil {
		t.Fatal(err)
	}
	if err := RegisterMailbox(env, "codex", "live-worker", "host", "/project", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	if got := mailboxSessions(env, "codex", "host"); len(got) != 2 {
		t.Fatalf("live receivers: %#v", got)
	}
	req := Request{Address: "shuttle://host/codex/old-worker", Text: "context", MessageID: "before"}
	if receipt, err := queueMailbox(env, Address{Host: "host", Harness: "codex", ID: "old-worker"}, req); err != nil || receipt.Status != StatusQueued {
		t.Fatalf("live receiver refused: %#v %v", receipt, err)
	}

	_ = receiver.Process.Kill()
	_, _ = receiver.Process.Wait()

	got := mailboxSessions(env, "codex", "host")
	if len(got) != 1 || got[0].ID != "live-worker" {
		t.Fatalf("exited receiver still discovered: %#v", got)
	}
	if MailboxAvailable(env, "codex", "old-worker", "host") {
		t.Fatal("exited receiver still advertised")
	}
	req.MessageID = "after"
	receipt, err := queueMailbox(env, Address{Host: "host", Harness: "codex", ID: "old-worker"}, req)
	if err == nil || receipt.Status != StatusRejected || ErrorCode(err) != "unavailable" || !strings.Contains(receipt.Detail, "no longer running") {
		t.Fatalf("exited receiver was not refused honestly: %#v %v", receipt, err)
	}
	if _, err := os.Stat(filepath.Join(mailboxDir(env, "codex", "old-worker"), "pending", mailboxKey("after")+".json")); !os.IsNotExist(err) {
		t.Fatalf("message queued for an exited receiver: %v", err)
	}
}

func TestMailboxRegistrationWithoutReceiverProcessIsNotLive(t *testing.T) {
	env := testEnv(t)
	env.Set("SHUTTLE_DATA_DIR", t.TempDir())
	dir := mailboxDir(env, "codex", "legacy")
	if err := ensureDir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	legacy := `{"id":"legacy","host":"host","cwd":"/project","last_seen":1}`
	if err := os.WriteFile(filepath.Join(dir, "receiver.json"), []byte(legacy), 0600); err != nil {
		t.Fatal(err)
	}
	if got := mailboxSessions(env, "codex", "host"); len(got) != 0 {
		t.Fatalf("unverifiable registration discovered: %#v", got)
	}
	if MailboxAvailable(env, "codex", "legacy", "host") {
		t.Fatal("unverifiable registration advertised")
	}
}

func TestRegisterMailboxRefusesAReceiverThatIsNotRunning(t *testing.T) {
	env := testEnv(t)
	env.Set("SHUTTLE_DATA_DIR", t.TempDir())
	receiver := startReceiver(t)
	pid := receiver.Process.Pid
	_ = receiver.Process.Kill()
	_, _ = receiver.Process.Wait()
	for _, candidate := range []int{0, -1, pid} {
		if err := RegisterMailbox(env, "claude", "s", "host", "/", candidate, true); err == nil {
			t.Fatalf("registered receiver pid %d", candidate)
		}
	}
	if _, err := os.Stat(filepath.Join(mailboxDir(env, "claude", "s"), "receiver.json")); !os.IsNotExist(err) {
		t.Fatalf("registration written for a missing receiver: %v", err)
	}
}

func TestProcessParentMatchesGetppid(t *testing.T) {
	ppid, name, ok := processParent(os.Getpid())
	if !ok || ppid != os.Getppid() || name == "" || !strings.HasPrefix(filepath.Base(os.Args[0]), name) {
		t.Fatalf("processParent(self) = %d %q %v; want ppid %d, name prefixing %q", ppid, name, ok, os.Getppid(), filepath.Base(os.Args[0]))
	}
	if start := processStartToken(os.Getpid()); start == "" || !processAlive(os.Getpid(), start) {
		t.Fatalf("own start token %q does not verify", start)
	}
	if processAlive(os.Getpid(), "not-a-start-token") {
		t.Fatal("a mismatched start token verified")
	}
}

// TestHookReceiverPIDSkipsShells runs this test binary as a stand-in harness
// that launches a hook through a shell which cannot exec it away; the hook
// must name the harness, not the shell.
func TestHookReceiverPIDSkipsShells(t *testing.T) {
	switch os.Getenv("SHUTTLE_TEST_HOOK_ROLE") {
	case "hook":
		os.Stdout.WriteString(strconv.Itoa(HookReceiverPID()) + " " + strconv.Itoa(os.Getppid()) + "\n")
		return
	case "harness":
		cmd := exec.Command("/bin/sh", "-c", `"$0" -test.run='^TestHookReceiverPIDSkipsShells$'; status=$?; exit $status`, os.Args[0])
		cmd.Env = append(os.Environ(), "SHUTTLE_TEST_HOOK_ROLE=hook")
		out, err := cmd.Output()
		if err != nil {
			t.Fatal(err)
		}
		fields := strings.Fields(strings.SplitN(string(out), "\n", 2)[0])
		if len(fields) != 2 || fields[1] == strconv.Itoa(os.Getpid()) {
			t.Fatalf("hook output %q: the shell did not stand between harness %d and hook", out, os.Getpid())
		}
		if fields[0] != strconv.Itoa(os.Getpid()) {
			t.Fatalf("hook named %s; harness is %d", fields[0], os.Getpid())
		}
		return
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestHookReceiverPIDSkipsShells$", "-test.v")
	cmd.Env = append(os.Environ(), "SHUTTLE_TEST_HOOK_ROLE=harness")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("harness: %v\n%s", err, out)
	}
}

func TestSendToExitedHookReceiverIsRejectedNotQueued(t *testing.T) {
	env := testEnv(t)
	env.Set("SHUTTLE_DATA_DIR", t.TempDir())
	env.Set("SHUTTLE_CODEX_SOCKET", filepath.Join(t.TempDir(), "absent.sock"))
	receiver := startReceiver(t)
	if err := RegisterMailbox(env, "codex", "gone", "host", "/", receiver.Process.Pid, true); err != nil {
		t.Fatal(err)
	}
	_ = receiver.Process.Kill()
	_, _ = receiver.Process.Wait()
	receipt, err := Send(context.Background(), env, "host", Request{Address: "shuttle://host/codex/gone", Text: "hi", MessageID: "m"})
	if err == nil || receipt.Status != StatusRejected {
		t.Fatalf("context-only send to exited receiver: %#v %v", receipt, err)
	}
}
