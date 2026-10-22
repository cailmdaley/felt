package messaging

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestFiberContextDormantRetryAndDedup(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	req := Request{MessageID: "result", Text: "thread child rested: ready"}
	if err := QueueFiberContext(env, "fiber", req); err != nil {
		t.Fatal(err)
	}
	if err := DeliverFiberContext(context.Background(), env, "fiber", "host", "shuttle://host/claude/session"); err == nil {
		t.Fatal("delivered to missing receiver")
	}
	if err := RegisterMailbox(env, "claude", "session", "host", t.TempDir(), os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	if err := DeliverFiberContext(context.Background(), env, "fiber", "host", "shuttle://host/claude/session"); err != nil {
		t.Fatal(err)
	}
	if err := QueueFiberContext(env, "fiber", req); err != nil {
		t.Fatal(err)
	}
	if err := DeliverFiberContext(context.Background(), env, "fiber", "host", "shuttle://host/claude/session"); err != nil {
		t.Fatal(err)
	}
	var offered []Request
	if err := OfferMailbox(env, "claude", "session", "host", func(batch []Request) error { offered = append(offered, batch...); return nil }); err != nil {
		t.Fatal(err)
	}
	if len(offered) != 1 || offered[0].Wake || offered[0].Text != req.Text {
		t.Fatalf("offered: %+v", offered)
	}
	entries, err := os.ReadDir(filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending"))
	if err != nil || len(entries) != 0 {
		t.Fatalf("pending: %v %v", entries, err)
	}
}

// A session-local queued receipt is not a hook acknowledgment. The durable
// task queue must survive replacement in that interval.
func TestFiberContextSurvivesReplacementBeforeHookAcknowledgment(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	req := Request{MessageID: "result", Text: "thread child rested: ready"}
	if err := QueueFiberContext(env, "fiber", req); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"A", "B"} {
		if err := RegisterMailbox(env, "claude", id, "host", t.TempDir(), os.Getpid(), true); err != nil {
			t.Fatal(err)
		}
		if err := DeliverFiberContext(context.Background(), env, "fiber", "host", "shuttle://host/claude/"+id); err != nil {
			t.Fatal(err)
		}
		pending, err := os.ReadDir(filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending"))
		if err != nil || len(pending) != 1 {
			t.Fatalf("fiber result acknowledged before %s's hook: %v %v", id, pending, err)
		}
		if id == "A" {
			if err := RegisterMailbox(env, "claude", id, "host", "", os.Getpid(), false); err != nil {
				t.Fatal(err)
			}
		}
	}
	// Re-registering A must not reclaim B's pending result, even if A's
	// hook runs first. Registration and subscription are not authority.
	if err := RegisterMailbox(env, "claude", "A", "host", t.TempDir(), os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	staleEmit := func(batch []Request) error { t.Errorf("stale A received: %+v", batch); return nil }
	if err := OfferMailbox(env, "claude", "A", "host", staleEmit); err != nil {
		t.Fatal(err)
	}
	failedOutput := errors.New("hook output failed")
	if err := OfferMailbox(env, "claude", "B", "host", func([]Request) error { return failedOutput }); !errors.Is(err, failedOutput) {
		t.Fatalf("failed hook output: %v", err)
	}
	var received []Request
	emit := func(batch []Request) error { received = append(received, batch...); return nil }
	for i := 0; i < 2; i++ {
		if err := DeliverFiberContext(context.Background(), env, "fiber", "host", "shuttle://host/claude/B"); err != nil {
			t.Fatal(err)
		}
		if err := OfferMailbox(env, "claude", "B", "host", emit); err != nil {
			t.Fatal(err)
		}
		if err := QueueFiberContext(env, "fiber", req); err != nil {
			t.Fatal(err)
		}
	}
	// Authority persists across queue drain: A cannot take future results
	// either, even before another delivery call to B refreshes its subscription.
	next := Request{MessageID: "next", Text: "thread child rested: next result"}
	if err := QueueFiberContext(env, "fiber", next); err != nil {
		t.Fatal(err)
	}
	if err := OfferMailbox(env, "claude", "A", "host", staleEmit); err != nil {
		t.Fatal(err)
	}
	var future []Request
	for i := 0; i < 2; i++ {
		if err := OfferMailbox(env, "claude", "B", "host", func(batch []Request) error { future = append(future, batch...); return nil }); err != nil {
			t.Fatal(err)
		}
	}
	if len(future) != 1 || future[0].MessageID != next.MessageID {
		t.Fatalf("future results: %+v", future)
	}
	if err := OfferMailbox(env, "claude", "A", "host", staleEmit); err != nil {
		t.Fatal(err)
	}
	if len(received) != 1 || received[0].MessageID != req.MessageID || received[0].Text != req.Text {
		t.Fatalf("received: %+v", received)
	}
	pending, err := os.ReadDir(filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending"))
	if err != nil || len(pending) != 0 {
		t.Fatalf("acknowledged result still pending: %v %v", pending, err)
	}
}

func TestFiberContextReceiverAuthorityFailsClosed(t *testing.T) {
	t.Parallel()
	for _, scenario := range []string{"unavailable", "no-hook", "missing", "malformed", "other-harness", "wrong-host"} {
		t.Run(scenario, func(t *testing.T) {
			env := testEnv(t)
			req := Request{MessageID: "result", Text: "ready"}
			if err := QueueFiberContext(env, "fiber", req); err != nil {
				t.Fatal(err)
			}
			if err := RegisterMailbox(env, "claude", "A", "host", t.TempDir(), os.Getpid(), true); err != nil {
				t.Fatal(err)
			}
			if err := DeliverFiberContext(context.Background(), env, "fiber", "host", "shuttle://host/claude/A"); err != nil {
				t.Fatal(err)
			}
			harness, id := "claude", "B"
			destination := filepath.Join(mailboxDir(env, "fiber", "fiber"), "destination.json")
			switch scenario {
			case "unavailable":
				if err := DeliverFiberContext(context.Background(), env, "fiber", "host", "shuttle://host/claude/B"); err == nil {
					t.Fatal("accepted unavailable successor")
				}
			case "no-hook":
				harness = "pi"
				// A destination without hooks still revokes all predecessor hooks.
				_ = DeliverFiberContext(context.Background(), env, "fiber", "host", "shuttle://host/pi/B")
			case "missing":
				if err := os.Remove(destination); err != nil {
					t.Fatal(err)
				}
			case "malformed":
				if err := os.WriteFile(destination, []byte("{"), 0600); err != nil {
					t.Fatal(err)
				}
			case "other-harness":
				harness, id = "pi", "A"
				if err := RegisterMailbox(env, harness, id, "host", t.TempDir(), os.Getpid(), true); err != nil {
					t.Fatal(err)
				}
				if err := DeliverFiberContext(context.Background(), env, "fiber", "host", "shuttle://host/pi/A"); err != nil {
					t.Fatal(err)
				}
			case "wrong-host":
				if err := DeliverFiberContext(context.Background(), env, "fiber", "host", "shuttle://other/claude/B"); err == nil {
					t.Fatal("accepted foreign-host selection")
				}
			}
			var stale []Request
			if err := OfferMailbox(env, "claude", "A", "host", func(batch []Request) error { stale = append(stale, batch...); return nil }); err != nil {
				t.Fatal(err)
			}
			if scenario == "wrong-host" {
				if len(stale) != 1 {
					t.Fatalf("invalid selection changed valid authority: %+v", stale)
				}
				return
			}
			if len(stale) != 0 {
				t.Fatalf("unauthorized hook consumed: %+v", stale)
			}
			if err := RegisterMailbox(env, harness, id, "host", t.TempDir(), os.Getpid(), true); err != nil {
				t.Fatal(err)
			}
			if err := DeliverFiberContext(context.Background(), env, "fiber", "host", "shuttle://host/"+harness+"/"+id); err != nil {
				t.Fatal(err)
			}
			var received []Request
			for i := 0; i < 2; i++ {
				if err := OfferMailbox(env, harness, id, "host", func(batch []Request) error { received = append(received, batch...); return nil }); err != nil {
					t.Fatal(err)
				}
			}
			if len(received) != 1 || received[0].MessageID != req.MessageID {
				t.Fatalf("successor received: %+v", received)
			}
		})
	}
}

func TestFiberContextReplacementSerializesWithHookOutput(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	if err := QueueFiberContext(env, "fiber", Request{MessageID: "first", Text: "first"}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"A", "B"} {
		if err := RegisterMailbox(env, "claude", id, "host", t.TempDir(), os.Getpid(), true); err != nil {
			t.Fatal(err)
		}
	}
	if err := DeliverFiberContext(context.Background(), env, "fiber", "host", "shuttle://host/claude/A"); err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	releaseOutput := sync.OnceFunc(func() { close(release) })
	defer releaseOutput()
	aDone := make(chan error, 1)
	go func() {
		aDone <- OfferMailbox(env, "claude", "A", "host", func([]Request) error { close(entered); <-release; return nil })
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("A did not enter hook output")
	}
	bStarted, bDone := make(chan struct{}), make(chan error, 1)
	go func() {
		close(bStarted)
		bDone <- DeliverFiberContext(context.Background(), env, "fiber", "host", "shuttle://host/claude/B")
	}()
	<-bStarted
	select {
	case err := <-bDone:
		t.Fatalf("replacement bypassed in-flight hook's lock: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	releaseOutput()
	for _, done := range []chan error{aDone, bDone} {
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("mailbox lock did not release")
		}
	}
	if err := QueueFiberContext(env, "fiber", Request{MessageID: "next", Text: "next"}); err != nil {
		t.Fatal(err)
	}
	if err := OfferMailbox(env, "claude", "A", "host", func(batch []Request) error { t.Errorf("A consumed after replacement: %+v", batch); return nil }); err != nil {
		t.Fatal(err)
	}
	var received []Request
	for i := 0; i < 2; i++ {
		if err := OfferMailbox(env, "claude", "B", "host", func(batch []Request) error { received = append(received, batch...); return nil }); err != nil {
			t.Fatal(err)
		}
	}
	if len(received) != 1 || received[0].MessageID != "next" {
		t.Fatalf("B received: %+v", received)
	}
}

func TestFiberContextWakeUsesNativeTurnAndDoesNotReplay(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	_, sent := nativeClaudeFixture(t, env, func(frame map[string]any, transcript *os.File) { nativeRows(frame, transcript, false) })
	req := Request{MessageID: "closed-result", Text: "thread child closed: measured", Wake: true}
	if err := QueueFiberContext(env, "fiber", req); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := DeliverFiberContext(context.Background(), env, "fiber", "host", "shuttle://host/claude/session"); err != nil {
			t.Fatal(err)
		}
		if err := QueueFiberContext(env, "fiber", req); err != nil {
			t.Fatal(err)
		}
	}
	if sent.Load() != 1 {
		t.Fatalf("native turns = %d", sent.Load())
	}
}

func TestFiberContextDelayedSelectionCannotRestorePredecessor(t *testing.T) {
	t.Parallel()
	for _, successor := range []string{"B", "unavailable", "-"} {
		t.Run(successor, func(t *testing.T) {
			env := testEnv(t)
			if err := QueueFiberContext(env, "fiber", Request{MessageID: "result", Text: "ready"}); err != nil {
				t.Fatal(err)
			}
			for _, id := range []string{"A", "B"} {
				if err := RegisterMailbox(env, "claude", id, "host", t.TempDir(), os.Getpid(), true); err != nil {
					t.Fatal(err)
				}
			}
			// Selection epochs are assigned by the serialized owner, not by delayed delivery tasks.
			deliver := func(id string, epoch uint64) {
				address := "shuttle://host/claude/" + id
				if id == "-" {
					address = "-"
				}
				_ = DeliverFiberContext(context.Background(), env, "fiber", "host", address, epoch)
			}
			deliver(successor, 2)
			deliver("A", 1)
			var stale []Request
			if err := OfferMailbox(env, "claude", "A", "host", func(batch []Request) error { stale = append(stale, batch...); return nil }); err != nil {
				t.Fatal(err)
			}
			if len(stale) != 0 {
				t.Fatalf("delayed predecessor restored authority: %+v", stale)
			}
		})
	}
}
