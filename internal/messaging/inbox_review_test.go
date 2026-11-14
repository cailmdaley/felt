package messaging

import (
	"os"
	"path/filepath"
	"testing"
)

// A fiber entry with turn ask or idle must stay deliverable by the daemon's
// direct fiber delivery, which hands the stored request to Send.
func TestFiberEntryWithAskOrIdleTurnPassesSendValidation(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	for _, turn := range []string{"ask", "idle"} {
		if err := Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: turn, Text: "x"}, Wishes: Wishes{Turn: turn}}); err != nil {
			t.Fatal(err)
		}
		entry, err := readFiberMailboxEntry(filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending", mailboxKey(turn)+".json"))
		if err != nil {
			t.Fatal(err)
		}
		// sendFiberContextAttempt sets the worker address, then Send validates.
		request := entry.Request
		request.Address = "shuttle://host/claude/worker"
		if err := validateRequest("host", request); err != nil {
			t.Errorf("turn %s: direct delivery would be refused: %v", turn, err)
		}
	}
}

// A session inbox cannot start a turn (queueMailbox refuses wake with
// wake_required), so Enqueue must refuse turn force for a session rather than
// store an entry the hook offers as plain context.
func TestSessionInboxRefusesForceTurn(t *testing.T) {
	env := testEnv(t)
	if err := RegisterMailbox(env, "claude", "s", "host", t.TempDir(), os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	err := Enqueue(env, InboxEntry{Address: "shuttle://host/claude/s", Request: Request{MessageID: "m", Text: "x"}, Wishes: Wishes{Turn: "force"}})
	if err == nil {
		var got []Request
		_ = OfferMailbox(env, "claude", "s", "host", func(b []Request) error { got = append(got, b...); return nil })
		t.Fatalf("force entry accepted for a hook-only session inbox; offered as context: %+v", got)
	}
}
