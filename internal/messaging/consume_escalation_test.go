package messaging

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// An ask held as context for cost on an idle, costly worker asks for a fresh
// session once it has stayed unread for the escalation window, measured from
// when it became due, so a daemon restart does not reset it. A quiet entry is
// never escalated, and one the worker read in time leaves nothing to escalate.
func TestConsumeEscalatesAStaleCostHold(t *testing.T) {
	never := func(context.Context, *sysenv.Env, string, Request, string) (Receipt, error) {
		t.Fatal("costly worker woken")
		return Receipt{}, nil
	}
	consume := func(t *testing.T, env *sysenv.Env, w Worker) Consumption {
		t.Helper()
		result, err := consumeWith(context.Background(), env, "fiber", "host", w, never)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	age := func(t *testing.T, env *sysenv.Env, id string, by time.Duration) {
		t.Helper()
		path := filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending", mailboxKey(id)+".json")
		e := readEntry(t, path)
		e.QueuedAt -= by.Nanoseconds()
		if err := writeMailboxEntryKeepingTime(path, e); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("held within the window, fresh after it", func(t *testing.T) {
		env, w := consumeFixture(t)
		w.Idle, w.Costly = true, true
		putWish(t, env, "m", "ask", "hold")
		age(t, env, "m", 59*time.Minute)
		if r := consume(t, env, w); r.Action != "wait" || r.Held != "cost" {
			t.Fatalf("escalated inside the hour: %+v", r)
		}
		age(t, env, "m", 2*time.Minute)
		if r := consume(t, env, w); r.Action != "fresh" || len(r.Members) != 1 || r.Members[0] != "m" {
			t.Fatalf("a stale hold was not escalated: %+v", r)
		}
	})

	t.Run("the window is configurable", func(t *testing.T) {
		env, w := consumeFixture(t)
		w.Idle, w.Costly = true, true
		putWish(t, env, "m", "ask", "hold")
		if r := consume(t, env, w); r.Action != "wait" || r.Held != "cost" {
			t.Fatalf("escalated at once: %+v", r)
		}
		env.Set("SHUTTLE_COST_HOLD_ESCALATE_SEC", "0")
		if r := consume(t, env, w); r.Action != "fresh" {
			t.Fatalf("a zero window did not escalate: %+v", r)
		}
	})

	t.Run("a quiet entry is never escalated", func(t *testing.T) {
		env, w := consumeFixture(t)
		w.Idle, w.Costly = true, true
		putWish(t, env, "m", "none", "hold")
		age(t, env, "m", 48*time.Hour)
		if r := consume(t, env, w); r.Action != "wait" || r.Turn {
			t.Fatalf("a context-only entry asked for a turn: %+v", r)
		}
	})

	t.Run("an entry read in time leaves nothing to escalate", func(t *testing.T) {
		env, w := consumeFixture(t)
		w.Idle, w.Costly = true, true
		putWish(t, env, "m", "ask", "hold")
		if r := consume(t, env, w); r.Action != "wait" || r.Held != "cost" {
			t.Fatalf("got %+v", r)
		}
		// The worker's next turn takes the held entry through its hook.
		read := 0
		if err := OfferMailbox(env, "claude", "A", "host", func(batch []Request) error { read += len(batch); return nil }); err != nil {
			t.Fatal(err)
		}
		if read != 1 {
			t.Fatalf("hook read %d entries", read)
		}
		env.Set("SHUTTLE_COST_HOLD_ESCALATE_SEC", "0")
		if r := consume(t, env, w); r.Action != "wait" || r.Turn {
			t.Fatalf("a read entry escalated: %+v", r)
		}
	})
}
