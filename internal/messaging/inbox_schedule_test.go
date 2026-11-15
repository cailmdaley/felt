package messaging

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDelayedRetentionAndCancel(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	future := time.Now().Add(30 * 24 * time.Hour).UTC().Format(time.RFC3339)
	if err := Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: "later", Text: "check the fit"}, Wishes: Wishes{Turn: "ask", NotBefore: future}}); err != nil {
		t.Fatal(err)
	}
	root := mailboxDir(env, "fiber", "fiber")
	path := filepath.Join(root, "pending", mailboxKey("later")+".json")
	e, err := readFiberMailboxEntry(path)
	if err != nil {
		t.Fatal(err)
	}
	e.QueuedAt = time.Now().Add(-30 * 24 * time.Hour).UnixNano()
	e.Request.RetainedAt = time.Now().Add(-30 * 24 * time.Hour).UTC().Format(time.RFC3339)
	if err := writeFiberMailboxAttempt(path, e, ""); err != nil {
		t.Fatal(err)
	}
	if mailboxEntryExpired(e, time.Now()) {
		t.Fatal("future entry expired")
	}
	if n, err := WakingCount(env, "fiber"); err != nil || n != 0 {
		t.Fatalf("%d %v", n, err)
	}
	if err := PruneOfferedMailboxes(env, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	if err := CancelPending(env, "fiber", "later"); err != nil {
		t.Fatal(err)
	}
	if n, err := PendingCount(env, "fiber"); err != nil || n != 0 {
		t.Fatalf("%d %v", n, err)
	}
	offered, err := readFiberMailboxEntry(filepath.Join(root, "offered", mailboxKey("later")+".json"))
	if err != nil || offered.Disposition != "cancelled" {
		t.Fatalf("%+v %v", offered, err)
	}
	if err := CancelPending(env, "fiber", "later"); err == nil {
		t.Fatal("cancelled nonpending entry")
	}
}
