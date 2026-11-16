package messaging

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The production CLI and its disk claim participate here. A consume killed
// mid-send leaves its batch's manifest without a receipt: the next consume
// checks its thread result's currency and holds the batch without sending it
// again, and after the bound its one retry is marked as a possible repeat.
func TestConsumeBinaryCrashMidSend(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "shuttle-real")
	build := exec.Command("go", "build", "-o", bin, "../../cmd/shuttle")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, out)
	}
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "host")
	root := mailboxDir(env, "fiber", "fiber")
	// The CLI's thread currency check answers current and counts its calls.
	scripts := t.TempDir()
	checks := filepath.Join(scripts, "checks")
	wrapper := "#!/bin/sh\nif [ \"$1\" = thread-signal-current ]; then\n echo >> '" + checks + "'\n printf '{\"current\":true}\\n'\nelse\n exec '" + bin + "' \"$@\"\nfi\n"
	if err := os.WriteFile(filepath.Join(scripts, "shuttle"), []byte(wrapper), 0700); err != nil {
		t.Fatal(err)
	}
	env.Set("PATH", scripts+string(os.PathListSeparator)+env.Getenv("PATH"))
	checked := func() int {
		b, _ := os.ReadFile(checks)
		return len(b)
	}
	var injected atomic.Int32
	var texts []string
	held, release := make(chan struct{}), make(chan struct{})
	socket, closeSocket := piNativeFixture(t, func(frame map[string]any) any {
		texts = append(texts, frame["message"].(string))
		if injected.Add(1) == 1 {
			close(held)
			<-release
			return nil
		}
		return map[string]any{"ok": true, "requestId": frame["requestId"], "sessionId": frame["sessionId"], "delivery": "follow_up"}
	})
	defer closeSocket()
	if err := RegisterPiNative(env, "A", "host", t.TempDir(), socket, "", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) (string, error) {
		t.Helper()
		cmd := exec.Command(bin, args...)
		cmd.Env = env.Environ()
		out, err := cmd.CombinedOutput()
		return string(out), err
	}
	must := func(args ...string) string {
		t.Helper()
		out, err := run(args...)
		if err != nil {
			t.Fatalf("%v: %v %s", args, err, out)
		}
		return out
	}
	must("inbox", "put", "fiber", "ordinary", "ordinary text", "--turn", "ask")
	epoch := strings.TrimSpace(must("context-mailbox", "receiver", "fiber", "worker-A", "shuttle://host/pi/A"))
	must("inbox", "consume", "fiber", "shuttle://host/pi/A", epoch)
	if injected.Load() != 0 {
		t.Fatal("a consume without turn facts woke for ask")
	}
	signal, _ := json.Marshal(ThreadSignal{UID: "child", Verb: "closed", Stamp: time.Now().UTC().Format(time.RFC3339Nano), Owner: "host"})
	must("context-mailbox", "put", "fiber", "thread-result", "thread child closed: done", "--turn", "ask", "--thread-signal", string(signal))
	args := []string{"inbox", "consume", "fiber", "shuttle://host/pi/A", epoch, "--idle"}
	cmd := exec.Command(bin, args...)
	cmd.Env = env.Environ()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill() })
	select {
	case <-held:
	case <-time.After(10 * time.Second):
		t.Fatal("the send never reached the transport")
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	close(release)
	batches, err := readBatchManifests(root)
	if err != nil || len(batches) != 1 || batches[0].Receipt != nil || strings.Join(batches[0].Members, ",") != "ordinary,thread-result" {
		t.Fatalf("manifests=%+v %v", batches, err)
	}

	before := checked()
	out, err := run(args...)
	if err == nil || !strings.Contains(out, `"action":"wake"`) || injected.Load() != 1 || checked() == before {
		t.Fatalf("within the bound: %v %s, injections=%d, currency checks %d then %d", err, out, injected.Load(), before, checked())
	}
	batches[0].OpenedAt = time.Now().Add(-liveAttemptRetryAfter).UnixNano()
	if err := writeBatch(root, &batches[0]); err != nil {
		t.Fatal(err)
	}
	if out := must(args...); !strings.Contains(out, `"action":"wake"`) || injected.Load() != 2 || !strings.Contains(texts[1], "Possible repeat:") || !strings.Contains(texts[1], "thread child closed: done") {
		t.Fatalf("retry: %s, injections=%d, texts %q", out, injected.Load(), texts)
	}
	if n, _ := pendingCount(env, "fiber"); n != 0 {
		t.Fatalf("pending=%d", n)
	}
	if _, err := os.Stat(filepath.Join(dataDir(env), "messages")); !os.IsNotExist(err) {
		t.Fatalf("a batch wrote a messages/ receipt: %v", err)
	}
	must(args...)
	if injected.Load() != 2 {
		t.Fatal("duplicate injection")
	}

	must("inbox", "put", "idle-fiber", "idle-entry", "Wait for idle", "--turn", "idle")
	idleEpoch := strings.TrimSpace(must("context-mailbox", "receiver", "idle-fiber", "worker-A", "shuttle://host/pi/A"))
	must("inbox", "consume", "idle-fiber", "shuttle://host/pi/A", idleEpoch)
	if injected.Load() != 2 {
		t.Fatal("a consume without turn facts woke an idle-only entry")
	}
	if err := OfferMailbox(env, "pi", "A", "host", func(batch []Request) error { t.Fatalf("hook absorbed idle entry: %+v", batch); return nil }); err != nil {
		t.Fatal(err)
	}
	must("inbox", "consume", "idle-fiber", "shuttle://host/pi/A", idleEpoch, "--idle")
	if injected.Load() != 3 {
		t.Fatal("idle consume did not wake")
	}
}
