package messaging

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"
)

func TestFiberContextTransitionWaitsForEmission(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	for _, id := range []string{"A", "B"} {
		if err := RegisterMailbox(env, "claude", id, "host", t.TempDir(), os.Getpid(), true); err != nil {
			t.Fatal(err)
		}
	}
	epoch := transition(t, env, "A", "shuttle://host/claude/A")
	if err := QueueFiberContext(env, "fiber", Request{MessageID: "first", Text: "first"}); err != nil {
		t.Fatal(err)
	}
	if err := DeliverFiberContext(context.Background(), env, "fiber", "host", "shuttle://host/claude/A", epoch); err != nil {
		t.Fatal(err)
	}
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	unblock := sync.OnceFunc(func() { close(release) })
	defer unblock()
	go func() {
		done <- OfferMailbox(env, "claude", "A", "host", func([]Request) error { close(entered); <-release; return nil })
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("hook never entered")
	}
	transitioned := make(chan error, 1)
	go func() {
		_, err := TransitionFiberReceiver(env, "fiber", "host", "B", "shuttle://host/claude/B")
		transitioned <- err
	}()
	select {
	case err := <-transitioned:
		t.Fatalf("transition bypassed emission lock: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	unblock()
	for _, ch := range []chan error{done, transitioned} {
		select {
		case err := <-ch:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("lock never released")
		}
	}
}
