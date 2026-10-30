package messaging

import (
	"path/filepath"
	"testing"
	"time"
)

func TestOverdueFiberContextReportsOnlyPendingOlderThanThreshold(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	now := time.Now()
	if got, err := OverdueFiberContext(env, now, 10*time.Minute); err != nil || len(got) != 0 {
		t.Fatalf("empty queue: %v %v", got, err)
	}
	for _, id := range []string{"old", "new", "acknowledged"} {
		req := Request{MessageID: id, Text: id}
		if err := QueueFiberContext(env, "fiber", req); err != nil {
			t.Fatal(err)
		}
	}
	root := mailboxDir(env, "fiber", "fiber")
	path := filepath.Join(root, "pending", mailboxKey("old")+".json")
	entry, err := readFiberMailboxEntry(path)
	if err != nil {
		t.Fatal(err)
	}
	entry.QueuedAt = now.Add(-11 * time.Minute).UnixNano()
	entry.PossibleRepeat = true
	if err := writeFiberMailboxAttempt(path, entry, "shuttle://host/claude/previous"); err != nil {
		t.Fatal(err)
	}
	if err := offerMailboxEachValidated(root, func(req Request) bool { return req.MessageID == "acknowledged" }, nil, func(Request) error { return nil }); err != nil {
		t.Fatal(err)
	}
	got, err := OverdueFiberContext(env, now, 10*time.Minute)
	if err != nil || len(got) != 1 {
		t.Fatalf("overdue queue: %v %v", got, err)
	}
	if got[0].MessageID != "old" || got[0].AgeSeconds != 660 || got[0].AttemptAddress != "shuttle://host/claude/previous" || !got[0].PossibleRepeat {
		t.Fatalf("diagnostic: %+v", got[0])
	}
}
