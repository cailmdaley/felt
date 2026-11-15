package messaging

import (
	"context"
	"slices"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// A pass's answer reports the requested entry's own state, whatever else the
// pass sent: an earlier batch re-sent on this pass does not make an entry
// held for cost read as delivered, and a retried id that was delivered
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
	if err != nil || !slices.Equal(second.Members, []string{"m1"}) || second.Held != "cost" || second.Message != "pending" {
		t.Fatalf("second=%+v err=%v", second, err)
	}

	w.Message = "m1"
	retry, err := consumeWith(context.Background(), env, "fiber", "host", w, accepted)
	if err != nil || len(retry.Members) != 0 || retry.Message != "delivered" {
		t.Fatalf("retry=%+v err=%v", retry, err)
	}
}
