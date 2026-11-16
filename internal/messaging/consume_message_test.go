package messaging

import (
	"context"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// A pass's answer reports the requested entry's own state, whatever else the
// pass advanced: an earlier batch still open on this pass does not make an
// entry held for cost read as delivered, and a retried id that was delivered
// before reads as delivered.
func TestConsumeReportsTheRequestedMessage(t *testing.T) {
	env, w := consumeFixture(t)
	w.Idle = true
	putWish(t, env, "m1", "ask", "hold")
	unconfirmed := func(context.Context, *sysenv.Env, string, Request, string) (Receipt, error) {
		return Receipt{Status: StatusQueued}, nil
	}
	w.Message = "m1"
	first, _ := consumeWith(context.Background(), env, "fiber", "host", w, unconfirmed)
	if first.Action != "wake" || first.Message != "sent" {
		t.Fatalf("first=%+v", first)
	}

	putWish(t, env, "m2", "ask", "hold")
	w.Costly, w.Message = true, "m2"
	accepted := func(context.Context, *sysenv.Env, string, Request, string) (Receipt, error) {
		return Receipt{Status: StatusAccepted}, nil
	}
	second, err := consumeWith(context.Background(), env, "fiber", "host", w, accepted)
	if ErrorCode(err) != "unconfirmed" || !slices.Equal(second.Members, []string{"m1"}) || second.Held != "cost" || second.Message != "pending" {
		t.Fatalf("second=%+v err=%v", second, err)
	}

	// The conversation confirms m1's batch.
	root := mailboxDir(env, "fiber", "fiber")
	batch := batchOf(t, root, "m1")
	batch.Receipt.Status = StatusAccepted
	if err := writeBatch(root, batch); err != nil {
		t.Fatal(err)
	}
	w.Message = "m1"
	retry, err := consumeWith(context.Background(), env, "fiber", "host", w, accepted)
	if err != nil || len(retry.Members) != 0 || retry.Message != "delivered" {
		t.Fatalf("retry=%+v err=%v", retry, err)
	}
}

// An expired entry and an id the inbox does not hold read as unknown, never
// as delivered, so a retry of either is not reported delivered.
func TestConsumeReportsAnExpiredOrMissingMessageAsUnknown(t *testing.T) {
	env, w := consumeFixture(t)
	w.Idle = true
	old := time.Now().Add(-mailboxRetention - time.Hour).UTC().Format(time.RFC3339)
	putWish(t, env, "stale", "ask", "hold")
	pending := filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending", mailboxKey("stale")+".json")
	e, err := readFiberMailboxEntry(pending)
	if err != nil {
		t.Fatal(err)
	}
	e.Request.RetainedAt = old
	if err := writeMailboxEntry(pending, e); err != nil {
		t.Fatal(err)
	}
	accepted := func(context.Context, *sysenv.Env, string, Request, string) (Receipt, error) {
		return Receipt{Status: StatusAccepted}, nil
	}
	for _, id := range []string{"stale", "stale", "never-sent"} {
		w.Message = id
		got, err := consumeWith(context.Background(), env, "fiber", "host", w, accepted)
		if err != nil || got.Message != "unknown" || len(got.Members) != 0 {
			t.Fatalf("%s: %+v %v", id, got, err)
		}
	}
	e, err = readFiberMailboxEntry(filepath.Join(mailboxDir(env, "fiber", "fiber"), "offered", mailboxKey("stale")+".json"))
	if err != nil || e.Disposition != "expired" {
		t.Fatalf("the expired entry was not retired as expired: %+v %v", e, err)
	}
}
