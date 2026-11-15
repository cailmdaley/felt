package messaging

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestRecordDedupAndSettlement(t *testing.T) {
	env := testEnv(t)
	for i := 0; i < 3; i++ {
		created, _, err := BeginRecord(env, "fiber", "human-1", "human", "hello\n[Image: /tmp/test.png]")
		if err != nil || created != (i == 0) {
			t.Fatalf("created=%v err=%v", created, err)
		}
	}
	if n, err := PendingCount(env, "fiber"); err != nil || n != 0 {
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
func TestRecordRecordsALongLineCutShort(t *testing.T) {
	env := testEnv(t)
	text := strings.Repeat("x", 70_000)
	if created, _, err := BeginRecord(env, "fiber", "human-long", "human", text); err != nil || !created {
		t.Fatalf("%v %v", created, err)
	}
	e, err := readFiberMailboxEntry(filepath.Join(mailboxDir(env, "fiber", "fiber"), "offered", mailboxKey("human-long")+".json"))
	if err != nil || !strings.HasSuffix(e.Request.Text, "(truncated)") || len(e.Request.Text) > 64<<10 {
		t.Fatalf("len=%d %v", len(e.Request.Text), err)
	}
}

// An agent's fresh request is a record from its sender: never pending, so no
// waking message after it carries its text to the old worker.
func TestRecordFromAnAgentIsNeverOffered(t *testing.T) {
	env := testEnv(t)
	if created, _, err := BeginRecord(env, "fiber", "fresh-1", "shuttle://host/claude/A", "new session please"); err != nil || !created {
		t.Fatalf("%v %v", created, err)
	}
	if n, err := PendingCount(env, "fiber"); err != nil || n != 0 {
		t.Fatalf("a record is never pending: %d %v", n, err)
	}
	e, err := readFiberMailboxEntry(filepath.Join(mailboxDir(env, "fiber", "fiber"), "offered", mailboxKey("fresh-1")+".json"))
	if err != nil || e.Request.From != "shuttle://host/claude/A" || e.Wishes.Source != "message" {
		t.Fatalf("%+v %v", e, err)
	}
}
