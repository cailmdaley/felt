package messaging

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFiberContextWakeWithoutCodexDiscovery(t *testing.T) {
	env := testEnv(t)
	inputs := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case codexTerminalReceiverRoute:
			http.Error(w, "missing receiver", http.StatusNotFound)
		case codexTerminalInputRoute:
			inputs++
			fmt.Fprint(w, `{"status":"submitted"}`)
		default:
			t.Errorf("unexpected route %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	env.Set("SHUTTLE_DAEMON_URL", server.URL)
	const address = "shuttle://host/codex/worker"
	generation := transition(t, env, "execution", address)
	if err := Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: "wake", Text: "wake result", Wake: true}}); err != nil {
		t.Fatal(err)
	}
	if _, err := Consume(context.Background(), env, "fiber", "host", Worker{Address: address, Epoch: generation}); err != nil {
		t.Fatalf("wake failed: %v", err)
	}
	if n, err := pendingCount(env, "fiber"); err != nil || n != 0 || inputs != 1 {
		t.Fatalf("pending=%d inputs=%d err=%v", n, inputs, err)
	}
}
