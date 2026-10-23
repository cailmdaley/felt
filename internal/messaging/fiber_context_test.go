package messaging

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv"
)

func transition(t *testing.T, env *sysenv.Env, identity, address string) uint64 {
	t.Helper()
	n, err := TransitionFiberReceiver(env, "fiber", "host", identity, address)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// Registration/removal/rotation must fence the old hook before any delivery.
func TestFiberContextWorkerTransitions(t *testing.T) {
	t.Parallel()
	for _, successor := range []string{"B", "unavailable", "removed", "rotation"} {
		t.Run(successor, func(t *testing.T) {
			env := testEnv(t)
			for _, id := range []string{"A", "B"} {
				if err := RegisterMailbox(env, "claude", id, "host", t.TempDir(), os.Getpid(), true); err != nil {
					t.Fatal(err)
				}
			}
			a := "shuttle://host/claude/A"
			first := transition(t, env, "execution-A:A", a)
			if err := DeliverFiberContext(context.Background(), env, "fiber", "host", a, first); err != nil {
				t.Fatal(err)
			}
			if err := QueueFiberContext(env, "fiber", Request{MessageID: "result", Text: "original"}); err != nil {
				t.Fatal(err)
			}
			b, identity := "shuttle://host/claude/B", "execution-B:B"
			switch successor {
			case "removed":
				b, identity = "-", ""
			case "unavailable":
				b = "shuttle://host/claude/missing"
			case "rotation":
				identity = "execution-A:B"
			}
			second := transition(t, env, identity, b)
			if second <= first {
				t.Fatal("epoch did not advance")
			}
			// Delayed delivery selection cannot designate A, and stale hooks cannot emit.
			if err := DeliverFiberContext(context.Background(), env, "fiber", "host", a, first); err == nil {
				t.Fatal("stale selection succeeded")
			}
			if err := OfferMailbox(env, "claude", "A", "host", func(batch []Request) error { t.Errorf("stale A emitted: %+v", batch); return nil }); err != nil {
				t.Fatal(err)
			}
			// A fresh Env/process can re-adopt the same worker without changing the epoch.
			if n := transition(t, env, identity, b); n != second {
				t.Fatal("re-adoption changed epoch")
			}
			for i := 0; i < 3; i++ {
				_ = DeliverFiberContext(context.Background(), env, "fiber", "host", b, second)
			}
			if n := transition(t, env, identity, b); n != second {
				t.Fatal("flush changed epoch")
			}
			if successor == "removed" || successor == "unavailable" {
				second = transition(t, env, "execution-B:B", "shuttle://host/claude/B")
			}
			if err := DeliverFiberContext(context.Background(), env, "fiber", "host", "shuttle://host/claude/B", second); err != nil {
				t.Fatal(err)
			}
			failed := errors.New("output failed")
			if err := OfferMailbox(env, "claude", "B", "host", func([]Request) error { return failed }); !errors.Is(err, failed) {
				t.Fatalf("failed emission: %v", err)
			}
			var got []Request
			for i := 0; i < 2; i++ {
				if err := OfferMailbox(env, "claude", "B", "host", func(batch []Request) error { got = append(got, batch...); return nil }); err != nil {
					t.Fatal(err)
				}
				if err := QueueFiberContext(env, "fiber", Request{MessageID: "result", Text: "original"}); err != nil {
					t.Fatal(err)
				}
			}
			if len(got) != 1 || got[0].Text != "original" {
				t.Fatalf("received: %+v", got)
			}
		})
	}
}

func TestFiberContextAuthorityFailures(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	a := "shuttle://host/claude/A"
	first := transition(t, env, "A", a)
	if _, err := TransitionFiberReceiver(env, "fiber", "host", "B", "shuttle://other/claude/B"); err == nil {
		t.Fatal("foreign owner accepted")
	}
	if n := transition(t, env, "A", a); n != first {
		t.Fatal("invalid transition changed authority")
	}
	path := filepath.Join(mailboxDir(env, "fiber", "fiber"), "destination.json")
	if err := os.WriteFile(path, []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := TransitionFiberReceiver(env, "fiber", "host", "B", "-"); err == nil {
		t.Fatal("corruption reset authority")
	}
	if err := DeliverFiberContext(context.Background(), env, "fiber", "host", a, first); err == nil {
		t.Fatal("corrupt authority accepted")
	}
}

func TestFiberContextWakeUsesNativeTurnAndDoesNotReplay(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	_, sent := nativeClaudeFixture(t, env, func(frame map[string]any, transcript *os.File) { nativeRows(frame, transcript, false) })
	a := "shuttle://host/claude/session"
	epoch := transition(t, env, "execution:session", a)
	req := Request{MessageID: "closed-result", Text: "thread child closed: measured", Wake: true}
	for i := 0; i < 2; i++ {
		if err := QueueFiberContext(env, "fiber", req); err != nil {
			t.Fatal(err)
		}
		if err := DeliverFiberContext(context.Background(), env, "fiber", "host", a, epoch); err != nil {
			t.Fatal(err)
		}
	}
	if sent.Load() != 1 {
		t.Fatalf("native turns = %d", sent.Load())
	}
}

func TestPendingFiberContextCountsWhatNoWorkerHasTaken(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	if n, err := PendingFiberContext(env, "fiber"); err != nil || n != 0 {
		t.Fatalf("a fiber with no mailbox holds %d (%v), want 0", n, err)
	}
	for _, id := range []string{"one", "two", "two"} {
		if err := QueueFiberContext(env, "fiber", Request{MessageID: id, Text: "context " + id}); err != nil {
			t.Fatal(err)
		}
	}
	if n, err := PendingFiberContext(env, "fiber"); err != nil || n != 2 {
		t.Fatalf("pending = %d (%v), want 2", n, err)
	}
	if err := RegisterMailbox(env, "claude", "A", "host", t.TempDir(), os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	a := "shuttle://host/claude/A"
	generation := transition(t, env, "execution-A:A", a)
	if err := DeliverFiberContext(context.Background(), env, "fiber", "host", a, generation); err != nil {
		t.Fatal(err)
	}
	// A hook-ready receiver takes context on its next hook, not at delivery.
	if err := OfferMailbox(env, "claude", "A", "host", func([]Request) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if n, err := PendingFiberContext(env, "fiber"); err != nil || n != 0 {
		t.Fatalf("after its worker took them, pending = %d (%v), want 0", n, err)
	}
}
