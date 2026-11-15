package messaging

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The production CLI, disk claim and messages/ receipts participate here. The
// validator stops its parent after the durable claim, before the transport.
func TestConsumeBinaryCrashBeforeSend(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "shuttle-real")
	build := exec.Command("go", "build", "-o", bin, "../../cmd/shuttle")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, out)
	}
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "host")
	root := mailboxDir(env, "fiber", "fiber")
	gate := filepath.Join(t.TempDir(), "stopped")
	scripts := t.TempDir()
	wrapper := "#!/bin/sh\nif [ \"$1\" = thread-signal-current ]; then\n if ls '" + filepath.Join(root, "batches") + "'/*.json >/dev/null 2>&1 && [ ! -f '" + gate + "' ]; then\n kill -STOP \"$PPID\"\n touch '" + gate + "'\n fi\n printf '{\"current\":true}\\n'\nelse\n exec '" + bin + "' \"$@\"\nfi\n"
	if err := os.WriteFile(filepath.Join(scripts, "shuttle"), []byte(wrapper), 0700); err != nil {
		t.Fatal(err)
	}
	env.Set("PATH", scripts+string(os.PathListSeparator)+env.Getenv("PATH"))
	var injected atomic.Int32
	socket, closeSocket := piNativeFixture(t, func(frame map[string]any) any {
		injected.Add(1)
		return map[string]any{"ok": true, "requestId": frame["requestId"], "sessionId": frame["sessionId"], "delivery": "follow_up"}
	})
	defer closeSocket()
	if err := RegisterPiNative(env, "A", "host", t.TempDir(), socket, "", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command(bin, args...)
		cmd.Env = env.Environ()
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("%v: %v %s", args, err, out)
		}
		return string(out)
	}
	run("inbox", "put", "fiber", "ordinary", "ordinary text", "--turn", "ask")
	epoch := strings.TrimSpace(run("context-mailbox", "receiver", "fiber", "worker-A", "shuttle://host/pi/A"))
	run("context-mailbox", "deliver", "fiber", "shuttle://host/pi/A", epoch)
	if injected.Load() != 0 {
		t.Fatal("compatibility deliver woke for ask")
	}
	signal, _ := json.Marshal(ThreadSignal{UID: "child", Verb: "closed", Stamp: time.Now().UTC().Format(time.RFC3339Nano), Owner: "host"})
	run("context-mailbox", "put", "fiber", "thread-result", "thread child closed: done", "--turn", "ask", "--thread-signal", string(signal))
	if _, err := strconv.Atoi(epoch); err != nil {
		t.Fatal(epoch)
	}
	args := []string{"inbox", "consume", "fiber", "shuttle://host/pi/A", epoch, "--idle"}
	cmd := exec.Command(bin, args...)
	cmd.Env = env.Environ()
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill() })
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(gate); err == nil {
			break
		}
		if time.Now().After(deadline) {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			t.Fatalf("claim gate not reached: %s", output.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
	batches, err := readBatchManifests(root)
	if err != nil || len(batches) != 1 {
		t.Fatalf("manifests=%v %v", batches, err)
	}
	active := batches[0]
	if injected.Load() != 0 {
		t.Fatal("transport ran before crash")
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	result := run(args...)
	if !strings.Contains(result, "\"action\":\"wake\"") || injected.Load() != 1 {
		t.Fatalf("result=%s injections=%d", result, injected.Load())
	}
	receiptFiles, err := os.ReadDir(filepath.Join(dataDir(env), "messages"))
	if err != nil || len(receiptFiles) != 1 {
		t.Fatalf("receipts=%v %v", receiptFiles, err)
	}
	wantID := active.Payload.MessageID + "-" + mailboxKey(active.Conversation)[:16]
	if receiptFiles[0].Name() != mailboxKey(wantID)+".json" {
		t.Fatalf("changed transport id: %s", receiptFiles[0].Name())
	}
	if n, _ := pendingCount(env, "fiber"); n != 0 {
		t.Fatalf("pending=%d", n)
	}
	run(args...)
	if injected.Load() != 1 {
		t.Fatal("duplicate injection")
	}

	run("inbox", "put", "idle-fiber", "idle-entry", "Wait for idle", "--turn", "idle")
	idleEpoch := strings.TrimSpace(run("context-mailbox", "receiver", "idle-fiber", "worker-A", "shuttle://host/pi/A"))
	run("context-mailbox", "deliver", "idle-fiber", "shuttle://host/pi/A", idleEpoch)
	if injected.Load() != 1 {
		t.Fatal("compatibility deliver woke an idle-only entry")
	}
	if err := OfferMailbox(env, "pi", "A", "host", func(batch []Request) error { t.Fatalf("hook absorbed idle entry: %+v", batch); return nil }); err != nil {
		t.Fatal(err)
	}
	run("inbox", "consume", "idle-fiber", "shuttle://host/pi/A", idleEpoch, "--idle")
	if injected.Load() != 2 {
		t.Fatal("idle consume did not wake")
	}
}
