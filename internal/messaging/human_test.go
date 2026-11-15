package messaging

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestHumanInputDedupAndSettlement(t *testing.T) {
	env := testEnv(t)
	for i := 0; i < 3; i++ {
		created, err := BeginHuman(env, "fiber", "human-1", "hello\n[Image: /tmp/test.png]")
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
	if err := SettleHuman(env, "fiber", "human-1", "delivered"); err != nil {
		t.Fatal(err)
	}
	e, err := readFiberMailboxEntry(record)
	if err != nil || e.Wishes.Source != "human" || e.Disposition != "delivered" {
		t.Fatalf("%+v %v", e, err)
	}
	if created, err := BeginHuman(env, "fiber", "human-1", "hello"); err != nil || created {
		t.Fatalf("a delivered id submitted again: %v %v", created, err)
	}
}

// A line that never reached the worker may be submitted again under its id;
// one whose outcome is unknown may not.
func TestHumanInputRetriesOnlyAnUndeliverableLine(t *testing.T) {
	env := testEnv(t)
	if created, err := BeginHuman(env, "fiber", "human-2", "hello"); err != nil || !created {
		t.Fatalf("%v %v", created, err)
	}
	if err := SettleHuman(env, "fiber", "human-2", "undeliverable"); err != nil {
		t.Fatal(err)
	}
	if created, err := BeginHuman(env, "fiber", "human-2", "hello"); err != nil || !created {
		t.Fatalf("an undeliverable line was not submitted again: %v %v", created, err)
	}
	if created, err := BeginHuman(env, "fiber", "human-2", "hello"); err != nil || created {
		t.Fatalf("an unknown line was submitted again: %v %v", created, err)
	}
}

// The record holds a line over the inbox limit cut short; the caller
// transports the whole line.
func TestHumanInputRecordsALongLineCutShort(t *testing.T) {
	env := testEnv(t)
	text := strings.Repeat("x", 70_000)
	if created, err := BeginHuman(env, "fiber", "human-long", text); err != nil || !created {
		t.Fatalf("%v %v", created, err)
	}
	e, err := readFiberMailboxEntry(filepath.Join(mailboxDir(env, "fiber", "fiber"), "offered", mailboxKey("human-long")+".json"))
	if err != nil || !strings.HasSuffix(e.Request.Text, "(truncated)") || len(e.Request.Text) > 64<<10 {
		t.Fatalf("len=%d %v", len(e.Request.Text), err)
	}
}
