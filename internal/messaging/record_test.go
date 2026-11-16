package messaging

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestPulseRecordSurvivesInterruptedSend(t *testing.T) {
	env := testEnv(t)
	id := "pulse-key-2026-11-15T12:00:00Z"
	created, _, err := BeginRecord(env, "fiber", id, "shuttle", "tick", "pulse")
	if err != nil || !created {
		t.Fatalf("%v %v", created, err)
	}
	// Recovery uses the reserved tick identity, not the recovery clock.
	created, disposition, err := BeginRecord(env, "fiber", id, "shuttle", "tick", "pulse")
	if err != nil || created || disposition != "unknown" {
		t.Fatalf("%v %s %v", created, disposition, err)
	}
	e, err := readFiberMailboxEntry(recordPath(mailboxDir(env, "fiber", "fiber"), id))
	if err != nil || e.Wishes.Source != "pulse" || e.Request.From != "shuttle" {
		t.Fatalf("%+v %v", e, err)
	}
}

func TestVoiceRecordNeverAuthorizesAnotherPaste(t *testing.T) {
	env := testEnv(t)
	created, _, err := BeginRecord(env, "fiber", "voice-1", "human", "words", "voice")
	if err != nil || !created {
		t.Fatalf("%v %v", created, err)
	}
	for _, outcome := range []string{"unknown", "delivered", "undeliverable"} {
		if err := SettleRecord(env, "fiber", "voice-1", outcome); err != nil {
			t.Fatal(err)
		}
		created, disposition, err := BeginRecord(env, "fiber", "voice-1", "human", "words", "voice")
		if err != nil || created || disposition != outcome {
			t.Fatalf("%v %s %v", created, disposition, err)
		}
	}
}

func TestRecordDedupAndSettlement(t *testing.T) {
	env := testEnv(t)
	for i := 0; i < 3; i++ {
		created, _, err := BeginRecord(env, "fiber", "human-1", "human", "hello\n[Image: /tmp/test.png]")
		if err != nil || created != (i == 0) {
			t.Fatalf("created=%v err=%v", created, err)
		}
	}
	if n, err := pendingCount(env, "fiber"); err != nil || n != 0 {
		t.Fatalf("a human record is never pending: %d %v", n, err)
	}
	root := mailboxDir(env, "fiber", "fiber")
	record := filepath.Join(root, "offered", mailboxKey("human-1")+".json")
	before, err := readFiberMailboxEntry(record)
	if err != nil || before.Disposition != "unknown" {
		t.Fatalf("interrupted submission: %+v %v", before, err)
	}
	if err := SettleRecord(env, "fiber", "human-1", "delivered"); err != nil {
		t.Fatal(err)
	}
	e, err := readFiberMailboxEntry(record)
	if err != nil || e.Wishes.Source != "human" || e.Disposition != "delivered" {
		t.Fatalf("%+v %v", e, err)
	}
	if created, disposition, err := BeginRecord(env, "fiber", "human-1", "human", "hello"); err != nil || created || disposition != "delivered" {
		t.Fatalf("a delivered id submitted again: %v %q %v", created, disposition, err)
	}
}

// A line that never reached the worker may be submitted again under its id;
// one whose outcome is unknown may not.
func TestRecordRetriesOnlyAnUndeliverableLine(t *testing.T) {
	env := testEnv(t)
	if created, _, err := BeginRecord(env, "fiber", "human-2", "human", "hello"); err != nil || !created {
		t.Fatalf("%v %v", created, err)
	}
	if err := SettleRecord(env, "fiber", "human-2", "undeliverable"); err != nil {
		t.Fatal(err)
	}
	if created, _, err := BeginRecord(env, "fiber", "human-2", "human", "hello"); err != nil || !created {
		t.Fatalf("an undeliverable line was not submitted again: %v %v", created, err)
	}
	if created, disposition, err := BeginRecord(env, "fiber", "human-2", "human", "hello"); err != nil || created || disposition != "unknown" {
		t.Fatalf("an unknown line was submitted again: %v %q %v", created, disposition, err)
	}
}

// The record holds a line over the inbox limit cut short; the caller
// transports the whole line.
// A multi-byte line whose cut falls inside a character ends on the whole
// character before it.
func TestRecordRecordsALongLineCutShort(t *testing.T) {
	env := testEnv(t)
	for id, c := range map[string]struct{ text, want string }{
		"human-long":       {strings.Repeat("x", 70_000), strings.Repeat("x", 60_000) + " … (truncated)"},
		"human-multi-byte": {"x" + strings.Repeat("é", 35_000), "x" + strings.Repeat("é", 29_999) + " … (truncated)"},
	} {
		if created, _, err := BeginRecord(env, "fiber", id, "human", c.text); err != nil || !created {
			t.Fatalf("%s: %v %v", id, created, err)
		}
		e, err := readFiberMailboxEntry(filepath.Join(mailboxDir(env, "fiber", "fiber"), "offered", mailboxKey(id)+".json"))
		if err != nil || e.Request.Text != c.want {
			t.Fatalf("%s: len=%d want %d %v", id, len(e.Request.Text), len(c.want), err)
		}
	}
}

// An agent's fresh request is a record from its sender: never pending, so no
// waking message after it carries its text to the old worker.
func TestRecordFromAnAgentIsNeverOffered(t *testing.T) {
	env := testEnv(t)
	if created, _, err := BeginRecord(env, "fiber", "fresh-1", "shuttle://host/claude/A", "new session please"); err != nil || !created {
		t.Fatalf("%v %v", created, err)
	}
	if n, err := pendingCount(env, "fiber"); err != nil || n != 0 {
		t.Fatalf("a record is never pending: %d %v", n, err)
	}
	e, err := readFiberMailboxEntry(filepath.Join(mailboxDir(env, "fiber", "fiber"), "offered", mailboxKey("fresh-1")+".json"))
	if err != nil || e.Request.From != "shuttle://host/claude/A" || e.Wishes.Source != "message" {
		t.Fatalf("%+v %v", e, err)
	}
}
