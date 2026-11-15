package messaging

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The shipped binary subscribes an entry's --notify-when-idle when a fiber
// hook claims it and when a consume wakes the worker with it: each runs in
// its own process, outside `shuttle message`.
func TestIdleSubscriptionFromHookAndConsumeBinaries(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "shuttle-real")
	if out, err := exec.Command("go", "build", "-o", bin, "../../cmd/shuttle").CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, out)
	}
	run := func(env interface{ Environ() []string }, stdin string, args ...string) string {
		t.Helper()
		cmd := exec.Command(bin, args...)
		cmd.Env = env.Environ()
		cmd.Stdin = strings.NewReader(stdin)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("%v: %v %s", args, err, out)
		}
		return string(out)
	}
	subscribed := func(dataDir string) []string {
		t.Helper()
		records, _ := filepath.Glob(filepath.Join(dataDir, "idle", "*.json"))
		for _, r := range records {
			t.Cleanup(func() { _ = exec.Command("pkill", "-f", r).Run() })
		}
		return records
	}
	put := []string{"context-mailbox", "put", "--from", "shuttle://host/pi/S", "--notify-address", "shuttle://host/pi/S", "--notify-when-idle", "--turn", "ask", "--"}

	t.Run("hook claim", func(t *testing.T) {
		env := testEnv(t)
		env.Set("SHUTTLE_HOST", "host")
		env.Set("SHUTTLE_BOARD", "off")
		env.Set("SHUTTLE_EVENTS", "off")
		cwd := t.TempDir()
		run(env, `{"harness":"codex","hook_event_name":"SessionStart","session_id":"A","cwd":"`+cwd+`"}`, "hook", "event")
		run(env, "", "context-mailbox", "receiver", "fiber", "ident-A", "shuttle://host/codex/A")
		run(env, "", append(put, "fiber", "n1", "please look")...)
		run(env, `{"harness":"codex","hook_event_name":"PreToolUse","session_id":"A","cwd":"`+cwd+`"}`, "hook", "event")
		if n, _ := pendingCount(env, "fiber"); n != 0 {
			t.Fatalf("the hook did not claim the entry: pending=%d", n)
		}
		if records := subscribed(dataDir(env)); len(records) != 1 {
			t.Fatalf("idle subscriptions=%v", records)
		}
	})

	t.Run("consume wake", func(t *testing.T) {
		env := testEnv(t)
		env.Set("SHUTTLE_HOST", "host")
		socket, closeSocket := piNativeFixture(t, func(frame map[string]any) any {
			return map[string]any{"ok": true, "requestId": frame["requestId"], "sessionId": frame["sessionId"], "delivery": "follow_up"}
		})
		defer closeSocket()
		if err := RegisterPiNative(env, "A", "host", t.TempDir(), socket, "", os.Getpid(), true); err != nil {
			t.Fatal(err)
		}
		run(env, "", append(put, "fiber", "n2", "please look")...)
		epoch := strings.TrimSpace(run(env, "", "context-mailbox", "receiver", "fiber", "worker-A", "shuttle://host/pi/A"))
		if out := run(env, "", "inbox", "consume", "fiber", "shuttle://host/pi/A", epoch, "--idle"); !strings.Contains(out, `"action":"wake"`) {
			t.Fatalf("consume=%s", out)
		}
		if records := subscribed(dataDir(env)); len(records) != 1 {
			t.Fatalf("idle subscriptions=%v", records)
		}
	})
}
