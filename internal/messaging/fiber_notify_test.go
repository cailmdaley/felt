package messaging

import (
	"os"
	"testing"
)

func TestFiberHookSubscribesIdleOnce(t *testing.T) {
	env := testEnv(t)
	if err := RegisterMailbox(env, "pi", "A", "host", t.TempDir(), os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	address := "shuttle://host/pi/A"
	transition(t, env, "A", address)
	req := Request{MessageID: "notify", Text: "please look", From: "sender", NotifyAddress: "shuttle://host/pi/B", NotifyWhenIdle: true}
	if err := Enqueue(env, InboxEntry{Address: "fiber", Request: req, Wishes: Wishes{Turn: "ask"}}); err != nil {
		t.Fatal(err)
	}
	old := SpawnIdleWatcher
	defer func() { SpawnIdleWatcher = old }()
	watchers, offers := 0, 0
	SpawnIdleWatcher = func(string) error { watchers++; return nil }
	for i := 0; i < 2; i++ {
		if err := offerLinkedFiberContext(env, "pi", "A", "host", func(batch []Request) error { offers++; return nil }); err != nil {
			t.Fatal(err)
		}
	}
	if watchers != 1 || offers != 1 {
		t.Fatalf("watchers=%d offers=%d", watchers, offers)
	}
}
