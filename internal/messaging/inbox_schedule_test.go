package messaging

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A future entry is held through retention and counts, and leaves only by an
// explicit cancel, after which a delayed retry of its id names that outcome.
func TestDelayedEntryWaitsUntilCancelled(t *testing.T) {
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
	if err := writeMailboxEntry(path, e); err != nil {
		t.Fatal(err)
	}
	if summary, err := SummarizePending(env, "fiber"); err != nil || summary.Count != 0 || len(summary.Scheduled) != 1 {
		t.Fatalf("%+v %v", summary, err)
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
	if n, err := pendingCount(env, "fiber"); err != nil || n != 0 {
		t.Fatalf("%d %v", n, err)
	}
	offered, err := readFiberMailboxEntry(filepath.Join(root, "offered", mailboxKey("later")+".json"))
	if err != nil || offered.Disposition != "cancelled" {
		t.Fatalf("%+v %v", offered, err)
	}
	if err := CancelPending(env, "fiber", "later"); err == nil {
		t.Fatal("cancelled nonpending entry")
	}
	if err := Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: "later", Text: "check the fit"}, Wishes: Wishes{Turn: "ask", NotBefore: future}}); ErrorCode(err) != "already_settled" {
		t.Fatalf("a delayed retry of a cancelled id = %v, want already_settled", err)
	}
}
