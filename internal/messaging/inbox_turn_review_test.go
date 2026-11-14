package messaging

import (
	"path/filepath"
	"testing"
)

// A fiber entry's direct delivery sends its stored request through Send, whose
// validation every build shares. The wake fields Enqueue stores for each turn
// must be a request Send accepts, or the entry stays pending forever.
func TestEnqueuedFiberTurnsAreSendable(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	for _, turn := range []string{"none", "force", "ask", "idle"} {
		if err := Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: turn, Text: "text"}, Wishes: Wishes{Turn: turn}}); err != nil {
			t.Fatal(err)
		}
		entry, err := readFiberMailboxEntry(filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending", mailboxKey(turn)+".json"))
		if err != nil {
			t.Fatal(err)
		}
		r := entry.Request
		r.Address = "shuttle://h/claude/s"
		if err := validateRequest("h", r); err != nil {
			t.Errorf("turn %s: stored request is refused by Send: %v", turn, err)
		}
	}
}
