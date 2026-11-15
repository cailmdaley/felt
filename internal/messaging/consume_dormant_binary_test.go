package messaging

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// runTestHarness stands in for a harness process: it runs the shuttle hook
// named by SHUTTLE_TEST_HARNESS_HOOK once per frame in
// SHUTTLE_TEST_HARNESS_FRAMES (newline-separated), as the harness's child,
// prints each hook's output, then blocks until killed when
// SHUTTLE_TEST_HARNESS_HOLD is set.
func runTestHarness() {
	for _, frame := range strings.Split(os.Getenv("SHUTTLE_TEST_HARNESS_FRAMES"), "\n") {
		cmd := exec.Command(os.Getenv("SHUTTLE_TEST_HARNESS_HOOK"), "hook", "event")
		cmd.Stdin = strings.NewReader(frame)
		cmd.Stderr = os.Stderr
		out, err := cmd.Output()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Stdout.Write(out)
	}
	if os.Getenv("SHUTTLE_TEST_HARNESS_HOLD") != "" {
		select {}
	}
}

// The production CLI and an on-disk inbox, through enqueue, the dormant
// consume, a launch, a session killed before its first prompt, the lease
// lapsing, a second launch and the second session's first-prompt hook claim.
// The daemon's part is played by the CLI verbs it shells.
func TestDormantLaunchThroughTheRealCLI(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "shuttle")
	if out, err := exec.Command("go", "build", "-o", bin, "../../cmd/shuttle").CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, out)
	}
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "host")
	env.Set("SHUTTLE_EVENTS", "off")
	env.Set("SHUTTLE_BOARD", "off")
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
	answer := func() Consumption {
		t.Helper()
		var c Consumption
		if err := json.Unmarshal([]byte(run("inbox", "consume", "fiber", "-", "0")), &c); err != nil {
			t.Fatal(err)
		}
		return c
	}
	waking := func() int {
		t.Helper()
		var counts map[string]int
		if err := json.Unmarshal([]byte(run("inbox", "pending", "--waking", "fiber")), &counts); err != nil {
			t.Fatal(err)
		}
		return counts["fiber"]
	}
	harness := func(id string, hold bool, events ...string) *exec.Cmd {
		t.Helper()
		frames := make([]string, len(events))
		for i, event := range events {
			b, _ := json.Marshal(map[string]string{"session_id": id, "hook_event_name": event, "harness": "claude", "cwd": t.TempDir()})
			frames[i] = string(b)
		}
		cmd := exec.Command(os.Args[0])
		cmd.Env = append(env.Environ(), "SHUTTLE_TEST_HARNESS_HOOK="+bin, "SHUTTLE_TEST_HARNESS_FRAMES="+strings.Join(frames, "\n"))
		if hold {
			cmd.Env = append(cmd.Env, "SHUTTLE_TEST_HARNESS_HOLD=1")
		}
		return cmd
	}

	run("inbox", "put", "fiber", "quiet", "quiet text")
	run("inbox", "put", "fiber", "asked", "asked text", "--turn", "ask")
	run("inbox", "put", "fiber", "forced", "forced text", "--turn", "force")
	if n := waking(); n != 2 {
		t.Fatalf("waking = %d", n)
	}
	if c := answer(); c.Action != "launch" || strings.Join(c.Members, ",") != "asked,forced" {
		t.Fatalf("first consume = %+v", c)
	}
	if c := answer(); c.Action != "wait" || waking() != 0 {
		t.Fatalf("a launch in its lease was asked for again: %+v", c)
	}

	// The daemon launches B and makes it the receiver; B starts, registers its
	// hook, and is killed before its first prompt.
	run("context-mailbox", "receiver", "fiber", "worker:B", "shuttle://host/claude/B")
	b := harness("B", true, "SessionStart")
	if err := b.Start(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for !MailboxAvailable(env, "claude", "B", "host") {
		if time.Now().After(deadline) {
			t.Fatal("B never registered")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := b.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = b.Wait()
	run("context-mailbox", "receiver", "fiber", "", "-")
	if n, _ := pendingCount(env, "fiber"); n != 3 || answer().Action != "wait" {
		t.Fatalf("pending = %d; the entries left the inbox or the lease ended early", n)
	}

	lapseLease(t, env)
	if c := answer(); c.Action != "launch" || strings.Join(c.Members, ",") != "asked,forced" {
		t.Fatalf("consume after B died = %+v", c)
	}
	run("context-mailbox", "receiver", "fiber", "worker:C", "shuttle://host/claude/C")
	out, err := harness("C", false, "UserPromptSubmit").Output()
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"quiet text", "asked text", "forced text"} {
		if !strings.Contains(string(out), text) {
			t.Fatalf("C's first prompt lacks %q: %s", text, out)
		}
	}
	if n, _ := pendingCount(env, "fiber"); n != 0 {
		t.Fatalf("pending = %d after C's claim", n)
	}
	for _, id := range []string{"quiet", "asked", "forced"} {
		e := readEntry(t, filepath.Join(mailboxDir(env, "fiber", "fiber"), "offered", mailboxKey(id)+".json"))
		if e.Attempt == nil || e.Attempt.Outcome != attemptDelivered || e.Attempt.Conversation != "shuttle://host/claude/C" {
			t.Fatalf("%s attempt = %+v", id, e.Attempt)
		}
	}
	if c := answer(); c.Action != "wait" {
		t.Fatalf("a delivered batch launched again: %+v", c)
	}
}
