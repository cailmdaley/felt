package messaging

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestEntryWithoutWishesReadsAsItsEquivalentWishes(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	for _, tc := range []struct {
		name, file string
		want       Wishes
	}{
		{"context", `{"request":{"address":"","text":"x","wake":false,"message_id":"m"},"queued_at":1}`, Wishes{Source: "message", Turn: "none", Session: "any", IfCostly: "hold"}},
		{"wake", `{"request":{"address":"","text":"x","wake":true,"message_id":"m"},"queued_at":1}`, Wishes{Source: "message", Turn: "force", Session: "any", IfCostly: "hold"}},
		{"context if busy", `{"request":{"address":"shuttle://h/claude/s","text":"x","wake":false,"context_if_busy":true,"message_id":"m"},"queued_at":1}`, Wishes{Source: "message", Turn: "ask", Session: "any", IfCostly: "hold"}},
		{"idle only", `{"request":{"address":"","text":"x","wake":true,"idle_only":true,"message_id":"pulse-k-1"},"queued_at":1}`, Wishes{Source: "pulse", Turn: "idle", Session: "any", IfCostly: "hold"}},
		{"thread result", `{"request":{"address":"","text":"x","wake":true,"message_id":"thread-closed-abc"},"queued_at":1,"attempt_address":"shuttle://h/codex/s"}`, Wishes{Source: "thread", Turn: "force", Session: "any", IfCostly: "fresh"}},
	} {
		path := filepath.Join(dir, tc.name+".json")
		if err := os.WriteFile(path, []byte(tc.file), 0600); err != nil {
			t.Fatal(err)
		}
		entry, err := readFiberMailboxEntry(path)
		if err != nil {
			t.Fatal(err)
		}
		if entry.Wishes != tc.want {
			t.Errorf("%s: wishes = %+v, want %+v", tc.name, entry.Wishes, tc.want)
		}
	}
}

// legacyEntry is the entry shape a build without wishes reads.
type legacyEntry struct {
	Request struct {
		Text          string `json:"text"`
		Wake          *bool  `json:"wake"`
		ContextIfBusy bool   `json:"context_if_busy"`
		IdleOnly      bool   `json:"idle_only"`
		MessageID     string `json:"message_id"`
	} `json:"request"`
	QueuedAt int64 `json:"queued_at"`
}

func TestEnqueuedEntryCarriesTheWakeFieldsAnOlderBuildReads(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	for turn, want := range map[string][3]bool{
		"none":  {false, false, false},
		"force": {true, false, false},
		"ask":   {false, true, false},
		"idle":  {false, false, true},
	} {
		if err := Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: turn, Text: "text " + turn}, Wishes: Wishes{Turn: turn}}); err != nil {
			t.Fatal(err)
		}
		b, err := os.ReadFile(filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending", mailboxKey(turn)+".json"))
		if err != nil {
			t.Fatal(err)
		}
		var old legacyEntry
		if err := json.Unmarshal(b, &old); err != nil {
			t.Fatal(err)
		}
		r := old.Request
		if r.MessageID != turn || r.Text != "text "+turn || old.QueuedAt == 0 || r.Wake == nil {
			t.Fatalf("%s: legacy fields missing: %s", turn, b)
		}
		if got := [3]bool{*r.Wake, r.ContextIfBusy, r.IdleOnly}; got != want {
			t.Errorf("%s: wake, context_if_busy, idle_only = %v, want %v", turn, got, want)
		}
		var raw struct {
			Wishes map[string]any `json:"wishes"`
		}
		if err := json.Unmarshal(b, &raw); err != nil {
			t.Fatal(err)
		}
		if raw.Wishes["turn"] != turn || raw.Wishes["source"] != "message" {
			t.Errorf("%s: stored wishes = %v", turn, raw.Wishes)
		}
	}
}

func TestEnqueueRefusesUnknownWishes(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	for name, w := range map[string]Wishes{
		"source":     {Source: "email"},
		"turn":       {Turn: "later"},
		"session":    {Session: "newest"},
		"if_costly":  {IfCostly: "drop"},
		"not_before": {NotBefore: "tomorrow"},
	} {
		err := Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: name, Text: "x"}, Wishes: w})
		if ErrorCode(err) != "invalid_request" {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	err := Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: "conflict", Text: "x", Wake: true}, Wishes: Wishes{Turn: "none"}})
	if ErrorCode(err) != "invalid_request" {
		t.Errorf("turn conflicting with wake: err = %v", err)
	}
	if n, err := PendingCount(env, "fiber"); err != nil || n != 0 {
		t.Fatalf("refused entries were stored: %d %v", n, err)
	}
}

func TestEnqueueDedupFirstCaptureAndConflict(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	put := func(text string, derived bool) error {
		return Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: "id", Text: text}, Derived: derived})
	}
	if err := put("first", false); err != nil {
		t.Fatal(err)
	}
	if err := put("first", false); err != nil {
		t.Fatalf("identical retry: %v", err)
	}
	if err := put("second", false); ErrorCode(err) != "message_id_conflict" {
		t.Fatalf("caller id reused with other content: %v", err)
	}
	if err := put("second", true); err != nil {
		t.Fatalf("derived recapture: %v", err)
	}
	root := mailboxDir(env, "fiber", "fiber")
	entries, err := PendingEntries(env, "fiber")
	if err != nil || len(entries) != 1 {
		t.Fatalf("pending = %v %v", entries, err)
	}
	if err := offerMailboxEachValidated(root, func(Request) bool { return true }, nil, func(Request) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if err := put("third", true); err != nil {
		t.Fatalf("derived recapture of an offered entry: %v", err)
	}
	if err := put("third", false); ErrorCode(err) != "message_id_conflict" {
		t.Fatalf("offered id reused with other content: %v", err)
	}
	stored, err := readFiberMailboxEntry(filepath.Join(root, "offered", mailboxKey("id")+".json"))
	if err != nil || stored.Request.Text != "first" {
		t.Fatalf("first capture lost: %+v %v", stored.Request, err)
	}
	if n, err := PendingCount(env, "fiber"); err != nil || n != 0 {
		t.Fatalf("recapture re-queued: %d %v", n, err)
	}
}

func TestEnqueueForASessionNeedsItsLiveHook(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	address := "shuttle://host/codex/receiver"
	if err := Enqueue(env, InboxEntry{Address: address, Request: Request{MessageID: "m", Text: "x"}}); ErrorCode(err) != "unavailable" {
		t.Fatalf("unregistered session: %v", err)
	}
	if err := RegisterMailbox(env, "codex", "receiver", "host", "/project", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	if err := Enqueue(env, InboxEntry{Address: address, Request: Request{MessageID: "m", Text: "x"}}); err != nil {
		t.Fatal(err)
	}
	entries, err := PendingEntries(env, address)
	if err != nil || len(entries) != 1 || entries[0].MessageID != "m" {
		t.Fatalf("pending = %v %v", entries, err)
	}
}

func TestReadersHonourNotBefore(t *testing.T) {
	t.Parallel()
	later := time.Now().Add(time.Hour).Format(time.RFC3339)
	earlier := time.Now().Add(-time.Minute).Format(time.RFC3339)

	t.Run("hook offer", func(t *testing.T) {
		t.Parallel()
		env := testEnv(t)
		address := "shuttle://host/codex/receiver"
		if err := RegisterMailbox(env, "codex", "receiver", "host", "/project", os.Getpid(), true); err != nil {
			t.Fatal(err)
		}
		for id, at := range map[string]string{"later": later, "earlier": earlier} {
			if err := Enqueue(env, InboxEntry{Address: address, Request: Request{MessageID: id, Text: id}, Wishes: Wishes{NotBefore: at}}); err != nil {
				t.Fatal(err)
			}
		}
		var offered []string
		if err := OfferMailbox(env, "codex", "receiver", "host", func(batch []Request) error {
			for _, r := range batch {
				offered = append(offered, r.MessageID)
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		if len(offered) != 1 || offered[0] != "earlier" {
			t.Fatalf("offered %v", offered)
		}
		if n, err := PendingCount(env, address); err != nil || n != 1 {
			t.Fatalf("delayed entry not left pending: %d %v", n, err)
		}
	})

	t.Run("fiber delivery", func(t *testing.T) {
		t.Parallel()
		env := testEnv(t)
		if err := Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: "later", Text: "later"}, Wishes: Wishes{Turn: "force", NotBefore: later}}); err != nil {
			t.Fatal(err)
		}
		delivered := 0
		if err := offerMailboxEachValidated(mailboxDir(env, "fiber", "fiber"), func(Request) bool { return true }, nil, func(Request) error { delivered++; return nil }); err != nil {
			t.Fatal(err)
		}
		if delivered != 0 {
			t.Fatal("a delayed entry was delivered")
		}
	})

	t.Run("claude fallback", func(t *testing.T) {
		t.Parallel()
		env := testEnv(t)
		address := "shuttle://host/claude/session"
		if err := RegisterMailbox(env, "claude", "session", "host", "/project", os.Getpid(), true); err != nil {
			t.Fatal(err)
		}
		if err := Enqueue(env, InboxEntry{Address: address, Request: Request{MessageID: "later", Text: "later", From: "shuttle://host/claude/sender"}, Wishes: Wishes{Turn: "ask", NotBefore: later}}); err != nil {
			t.Fatal(err)
		}
		pending, err := RecoverClaudeMail(context.Background(), env, "host", time.Now(), nil)
		if err != nil || pending {
			t.Fatalf("recover = %v %v", pending, err)
		}
		if _, err := os.Stat(filepath.Join(mailboxDir(env, "claude", "session"), "fallback")); !os.IsNotExist(err) {
			t.Fatalf("a delayed entry was claimed by the fallback: %v", err)
		}
	})

	t.Run("overdue", func(t *testing.T) {
		t.Parallel()
		env := testEnv(t)
		now := time.Now()
		for id, at := range map[string]string{"later": later, "earlier": earlier} {
			if err := Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: id, Text: id}, Wishes: Wishes{NotBefore: at}}); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending", mailboxKey(id)+".json")
			entry, err := readFiberMailboxEntry(path)
			if err != nil {
				t.Fatal(err)
			}
			entry.QueuedAt = now.Add(-2 * time.Hour).UnixNano()
			if err := writeFiberMailboxAttempt(path, entry, ""); err != nil {
				t.Fatal(err)
			}
		}
		got, err := OverdueFiberContext(env, now, 30*time.Second)
		if err != nil || len(got) != 1 || got[0].MessageID != "earlier" || got[0].AgeSeconds > 120 {
			t.Fatalf("overdue = %+v %v", got, err)
		}
	})
}
