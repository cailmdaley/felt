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
		{"wake if idle", `{"request":{"address":"","text":"x","wake":true,"context_if_busy":true,"message_id":"m"},"queued_at":1}`, Wishes{Source: "message", Turn: "ask", Session: "any", IfCostly: "hold"}},
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

// The request carries only the wake fields the inbox's readers act on, so an
// older build reads the entry the same way and Send accepts it.
func TestEnqueuedEntryCarriesTheWakeFieldsAnOlderBuildReads(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	for _, harness := range []string{"claude", "codex"} {
		if err := RegisterMailbox(env, harness, "s", "host", "/project", os.Getpid(), true); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		address, turn string
		want          [3]bool // wake, context_if_busy, idle_only
	}{
		{"fiber", "none", [3]bool{}},
		{"fiber", "force", [3]bool{true, false, false}},
		{"fiber", "ask", [3]bool{}},
		{"fiber", "idle", [3]bool{}},
		{"shuttle://host/claude/s", "none", [3]bool{}},
		{"shuttle://host/claude/s", "ask", [3]bool{false, true, false}},
		{"shuttle://host/codex/s", "ask", [3]bool{}},
	} {
		name := tc.address + " " + tc.turn
		if err := Enqueue(env, InboxEntry{Address: tc.address, Request: Request{MessageID: tc.turn, Text: "text " + tc.turn}, Wishes: Wishes{Turn: tc.turn}}); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		root, _ := inboxRoot(env, tc.address)
		b, err := os.ReadFile(filepath.Join(root, "pending", mailboxKey(tc.turn)+".json"))
		if err != nil {
			t.Fatal(err)
		}
		var old legacyEntry
		if err := json.Unmarshal(b, &old); err != nil {
			t.Fatal(err)
		}
		r := old.Request
		if r.MessageID != tc.turn || r.Text != "text "+tc.turn || old.QueuedAt == 0 || r.Wake == nil {
			t.Fatalf("%s: legacy fields missing: %s", name, b)
		}
		if got := [3]bool{*r.Wake, r.ContextIfBusy, r.IdleOnly}; got != tc.want {
			t.Errorf("%s: wake, context_if_busy, idle_only = %v, want %v", name, got, tc.want)
		}
		var raw struct {
			Wishes map[string]any `json:"wishes"`
		}
		if err := json.Unmarshal(b, &raw); err != nil {
			t.Fatal(err)
		}
		if raw.Wishes["turn"] != tc.turn || raw.Wishes["source"] != "message" {
			t.Errorf("%s: stored wishes = %v", name, raw.Wishes)
		}
	}
}

func TestSessionInboxRefusesTurnsItCannotStart(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	if err := RegisterMailbox(env, "codex", "s", "host", "/project", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	for _, turn := range []string{"force", "idle"} {
		err := Enqueue(env, InboxEntry{Address: "shuttle://host/codex/s", Request: Request{MessageID: turn, Text: "x"}, Wishes: Wishes{Turn: turn}})
		if ErrorCode(err) != "wake_required" {
			t.Errorf("%s: err = %v", turn, err)
		}
	}
	if n, err := PendingCount(env, "shuttle://host/codex/s"); err != nil || n != 0 {
		t.Fatalf("refused entries were stored: %d %v", n, err)
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

// Stated wishes are content; a turn left unsaid follows wake, which is routing.
func TestEnqueueDedupComparesStatedWishes(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	later := time.Now().Add(time.Hour).Format(time.RFC3339)
	put := func(id string, wake bool, w Wishes) error {
		return Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: id, Text: "x", Wake: wake}, Wishes: w})
	}
	if err := put("wake", false, Wishes{}); err != nil {
		t.Fatal(err)
	}
	if err := put("wake", true, Wishes{}); err != nil {
		t.Fatalf("retry differing only in wake: %v", err)
	}
	if err := put("turn", false, Wishes{Turn: "ask"}); err != nil {
		t.Fatal(err)
	}
	for name, w := range map[string]Wishes{
		"turn":       {Turn: "force"},
		"not_before": {Turn: "ask", NotBefore: later},
		"source":     {Turn: "ask", Source: "human"},
	} {
		if err := put("turn", false, w); ErrorCode(err) != "message_id_conflict" {
			t.Errorf("reuse with another %s: %v", name, err)
		}
	}
	if err := put("turn", false, Wishes{Turn: "ask"}); err != nil {
		t.Fatalf("identical retry: %v", err)
	}
}

// A session inbox keeps exclusive creation: an id already pending is refused,
// and an offered id may be queued again.
func TestSessionInboxRefusesAPendingIdAndRequeuesAnOfferedOne(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	if err := RegisterMailbox(env, "codex", "s", "host", "/project", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	put := func() error {
		return Enqueue(env, InboxEntry{Address: "shuttle://host/codex/s", Request: Request{MessageID: "m", Text: "x"}})
	}
	if err := put(); err != nil {
		t.Fatal(err)
	}
	if err := put(); err == nil {
		t.Fatal("an id already pending was accepted")
	}
	if err := OfferMailbox(env, "codex", "s", "host", func([]Request) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if err := put(); err != nil {
		t.Fatalf("offered id: %v", err)
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

func TestFiberDeliveryHonoursNotBefore(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	_, sent := nativeClaudeFixture(t, env, func(frame map[string]any, transcript *os.File) { nativeRows(frame, transcript, false) })
	a := "shuttle://host/claude/session"
	epoch := transition(t, env, "execution:session", a)
	for id, at := range map[string]string{"later": time.Now().Add(time.Hour).Format(time.RFC3339), "due": ""} {
		if err := Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: id, Text: id}, Wishes: Wishes{Turn: "force", NotBefore: at}}); err != nil {
			t.Fatal(err)
		}
	}
	if err := DeliverFiberContext(context.Background(), env, "fiber", "host", a, epoch); err != nil {
		t.Fatal(err)
	}
	entries, err := PendingEntries(env, "fiber")
	if err != nil || sent.Load() != 1 || len(entries) != 1 || entries[0].MessageID != "later" {
		t.Fatalf("native turns = %d, pending = %+v %v", sent.Load(), entries, err)
	}
}
