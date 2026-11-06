package shuttlecli

import (
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/messaging"
)

func TestHookInterruptedRecordsTranscriptInterrupt(t *testing.T) {
	t.Parallel()
	env, path := eventStream(t)

	cmd := newApp(env).hookInterruptedCmd()
	cmd.SetArgs([]string{"--session", "s1", "--harness", "claude", "--cwd", "/w", "--id", "rec-1", "--at", "1792305395592"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}

	lines := readEventLines(t, path)
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1", len(lines))
	}
	line := lines[0]
	want := map[string]any{
		"id": "s1-interrupted-rec-1", "type": "interrupted", "sessionId": "s1",
		"timestamp": float64(1792305395592), "harness": "claude-code", "cwd": "/w",
	}
	for k, v := range want {
		if line[k] != v {
			t.Fatalf("%s = %v, want %v (line %v)", k, line[k], v, line)
		}
	}
	for _, k := range []string{"receiverPid", "receiverBirth"} {
		if _, present := line[k]; present {
			t.Fatalf("%s present; the daemon is not the receiver", k)
		}
	}
}

func TestClaudeInterruptUpdatesOnlyTheCurrentTurn(t *testing.T) {
	env := messageHookEnv(t, "host")
	if err := messaging.RegisterMailbox(env, "claude", "s", "host", "/tmp", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	at := time.Now().UnixMilli()
	if err := messaging.SetMailboxStateAt(env, "claude", "s", "host", "working", at); err != nil {
		t.Fatal(err)
	}
	interrupt := func(timestamp int64) {
		t.Helper()
		cmd := newApp(env).hookInterruptedCmd()
		cmd.SetArgs([]string{"--session", "s", "--harness", "claude", "--id", "r", "--at", fmt.Sprint(timestamp)})
		if err := cmd.Execute(); err != nil {
			t.Fatal(err)
		}
	}
	interrupt(at + 1)
	if state, _ := messaging.MailboxState(env, "claude", "s", "host"); state != "idle" {
		t.Fatalf("interrupt state = %q", state)
	}
	if err := messaging.SetMailboxStateAt(env, "claude", "s", "host", "working", at+2); err != nil {
		t.Fatal(err)
	}
	interrupt(at + 1)
	if state, _ := messaging.MailboxState(env, "claude", "s", "host"); state != "working" {
		t.Fatalf("stale interrupt changed state = %q", state)
	}
}

func TestHookInterruptedRejectsIncompleteFlags(t *testing.T) {
	t.Parallel()
	env, _ := eventStream(t)
	for _, args := range [][]string{
		{"--harness", "claude", "--id", "r", "--at", "1"},
		{"--session", "s", "--harness", "claude", "--at", "1"},
		{"--session", "s", "--harness", "claude", "--id", "r"},
		{"--session", "s", "--harness", "pi", "--id", "r", "--at", "1"},
	} {
		cmd := newApp(env).hookInterruptedCmd()
		cmd.SetArgs(args)
		cmd.SilenceUsage, cmd.SilenceErrors = true, true
		if err := cmd.Execute(); err == nil {
			t.Fatalf("%v: accepted", args)
		}
	}
}
