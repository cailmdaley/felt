package messaging

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

func TestReview1RejectedRetryPreservesOriginalAmbiguity(t *testing.T) {
	env := testEnv(t)
	r := Request{MessageID: "m", Text: "original", Wake: true}
	if err := Enqueue(env, InboxEntry{Address: "fiber", Request: r}); err != nil {
		t.Fatal(err)
	}
	a, b := "shuttle://host/codex/A", "shuttle://host/codex/B"
	transition(t, env, "A", a)
	path := filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending", mailboxKey("m")+".json")
	calls := 0
	var last Request
	sender := func(_ context.Context, _ *sysenv.Env, _ string, r Request, _ string) (Receipt, error) {
		calls++
		last = r
		if calls == 3 {
			return Receipt{Status: StatusRejected}, errCode("preflight_failed", "not sent")
		}
		return Receipt{Status: StatusUnknown}, errCode("ambiguous_delivery", "unknown")
	}
	_ = deliverBatch(t, env, a, r, sender)
	expireAttempt(t, path)
	_ = deliverBatch(t, env, a, r, sender)
	transition(t, env, "B", b)
	_ = deliverBatch(t, env, b, r, sender)
	if !strings.HasPrefix(last.Text, "Possible repeat:") {
		t.Fatalf("lost original ambiguity: %+v", last)
	}
}

func TestReview2ExhaustedRetryStillRollsToLiveSuccessor(t *testing.T) {
	env := testEnv(t)
	r := Request{MessageID: "m", Text: "original", Wake: true}
	if err := Enqueue(env, InboxEntry{Address: "fiber", Request: r}); err != nil {
		t.Fatal(err)
	}
	a, b := "shuttle://host/codex/A", "shuttle://host/codex/B"
	transition(t, env, "A", a)
	path := filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending", mailboxKey("m")+".json")
	var addresses []string
	sender := func(_ context.Context, _ *sysenv.Env, _ string, r Request, address string) (Receipt, error) {
		addresses = append(addresses, address)
		return Receipt{Status: StatusUnknown}, errCode("ambiguous_delivery", "unknown")
	}
	_ = deliverBatch(t, env, a, r, sender)
	expireAttempt(t, path)
	_ = deliverBatch(t, env, a, r, sender)
	expireAttempt(t, path)
	transition(t, env, "B", b)
	_ = deliverBatch(t, env, b, r, sender)
	if addresses[len(addresses)-1] != b {
		t.Fatalf("stuck at exhausted predecessor: %v", addresses)
	}
}

func TestReview7And8BatchTransportIDsAndRetryBounds(t *testing.T) {
	env, w := consumeFixture(t)
	w.Idle = true
	id := strings.Repeat("m", 239)
	if err := Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: id, Text: strings.Repeat("x", 65536)}, Wishes: Wishes{Turn: "ask"}}); err != nil {
		t.Fatal(err)
	}
	seen := map[string]string{}
	sender := func(_ context.Context, _ *sysenv.Env, _ string, r Request, address string) (Receipt, error) {
		r.Address = address
		r.MessageID += "-" + mailboxKey(address)[:16]
		if err := validateRequest("host", r); err != nil {
			t.Fatalf("invalid internal framing: %v", err)
		}
		if old, ok := seen[r.MessageID]; ok && old != r.Text {
			t.Fatal("transport id collision")
		}
		seen[r.MessageID] = r.Text
		return Receipt{Status: StatusUnknown}, errCode("ambiguous_delivery", "unknown")
	}
	_, _ = consumeWith(context.Background(), env, "fiber", "host", w, sender)
	root := mailboxDir(env, "fiber", "fiber")
	a, _ := readConsumedBatch(root)
	a.OpenedAt = time.Now().Add(-liveAttemptRetryAfter).UnixNano()
	_ = writeBatch(root, &a)
	_, _ = consumeWith(context.Background(), env, "fiber", "host", w, sender)
	if len(seen) != 2 {
		t.Fatalf("variants=%v", seen)
	}
	members := []string{"m"}
	plain := batchTransportID([]string{"m-retry-1"}, w.Address, "plain", "text")
	retry := batchTransportID(members, w.Address, "retry-1", "text")
	if plain == retry || len(retry) > 80 {
		t.Fatalf("unbounded or colliding ids: %q %q", plain, retry)
	}
}
