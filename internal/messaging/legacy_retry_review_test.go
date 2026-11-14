package messaging

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv"
)

func legacyReviewSender(t *testing.T) fiberContextSender {
	t.Helper()
	return func(ctx context.Context, env *sysenv.Env, _ string, r Request, address string) (Receipt, error) {
		r.Address = address
		r.MessageID += "-" + mailboxKey(address)[:16]
		if err := validateRequest("host", r); err != nil {
			t.Fatalf("invalid retry framing: %v", err)
		}
		return withDedup(ctx, env, r, func(context.Context) dedupSendResult {
			return dedupSendResult{Receipt: Receipt{Status: StatusUnknown}, Err: errCode("ambiguous_delivery", "unknown")}
		})
	}
}

func TestLegacyReview4ReturningToADoesNotConflict(t *testing.T) {
	env := testEnv(t)
	r := Request{MessageID: "m", Text: "original", Wake: true}
	if err := Enqueue(env, InboxEntry{Address: "fiber", Request: r}); err != nil {
		t.Fatal(err)
	}
	a, b := "shuttle://host/codex/A", "shuttle://host/codex/B"
	path := filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending", mailboxKey("m")+".json")
	sender := legacyReviewSender(t)
	for i, address := range []string{a, b, a} {
		transition(t, env, address, address)
		if i > 0 {
			expireAttempt(t, path)
		}
		if err := deliverFiberContextItemWith(context.Background(), env, "fiber", "host", address, r, sender); ErrorCode(err) != "ambiguous_delivery" {
			t.Fatalf("returning conversation got %v", err)
		}
	}
}

func TestLegacyReview7MaxPublicationCanRetry(t *testing.T) {
	for _, r := range []Request{
		{MessageID: "max-text", Text: strings.Repeat("x", 65536), Wake: true},
		{MessageID: strings.Repeat("m", 239), Text: "original", Wake: true},
	} {
		t.Run(r.MessageID[:8], func(t *testing.T) {
			env := testEnv(t)
			address := "shuttle://host/codex/A"
			transition(t, env, "A", address)
			if err := Enqueue(env, InboxEntry{Address: "fiber", Request: r}); err != nil {
				t.Fatal(err)
			}
			sender := legacyReviewSender(t)
			_ = deliverFiberContextItemWith(context.Background(), env, "fiber", "host", address, r, sender)
			path := filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending", mailboxKey(r.MessageID)+".json")
			expireAttempt(t, path)
			if err := deliverFiberContextItemWith(context.Background(), env, "fiber", "host", address, r, sender); ErrorCode(err) != "ambiguous_delivery" {
				t.Fatalf("max publication retry: %v", err)
			}
		})
	}
}

func TestLegacyReview5CaveatReceiptVariant(t *testing.T) {
	env := testEnv(t)
	address := "shuttle://host/codex/A"
	transition(t, env, "A", address)
	r := Request{MessageID: "thread-result", Text: "thread child closed: original", Wake: true}
	if err := Enqueue(env, InboxEntry{Address: "fiber", Request: r}); err != nil {
		t.Fatal(err)
	}
	caveat := r
	caveat.Text = withStalenessCaveat(r.Text)
	sender := legacyReviewSender(t)
	_ = deliverFiberContextItemWith(context.Background(), env, "fiber", "host", address, caveat, sender)
	if err := deliverFiberContextItemWith(context.Background(), env, "fiber", "host", address, r, sender); ErrorCode(err) != "ambiguous_delivery" {
		t.Fatalf("validation recovery changed the in-flight variant: %v", err)
	}
}

func TestLegacyReview8PublicationCannotOccupyRetryID(t *testing.T) {
	env := testEnv(t)
	address := "shuttle://host/codex/A"
	transition(t, env, "A", address)
	original := Request{MessageID: "m", Text: "original", Wake: true}
	other := Request{MessageID: "m-retry-1", Text: "different publication", Wake: true}
	sender := legacyReviewSender(t)
	for _, r := range []Request{original, other} {
		if err := Enqueue(env, InboxEntry{Address: "fiber", Request: r}); err != nil {
			t.Fatal(err)
		}
		_ = deliverFiberContextItemWith(context.Background(), env, "fiber", "host", address, r, sender)
	}
	path := filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending", mailboxKey("m")+".json")
	expireAttempt(t, path)
	if err := deliverFiberContextItemWith(context.Background(), env, "fiber", "host", address, original, sender); ErrorCode(err) != "ambiguous_delivery" {
		t.Fatalf("retry collided with publication: %v", err)
	}
}
