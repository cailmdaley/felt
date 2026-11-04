package messaging

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestPinnedQuietCodexContextReturnsToFiberHook(t *testing.T) {
	for _, live := range []bool{false, true} {
		t.Run(fmt.Sprint("hook-available=", live), func(t *testing.T) {
			env := testEnv(t)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) }))
			defer server.Close()
			env.Set("SHUTTLE_DAEMON_URL", server.URL)
			const a = "shuttle://host/codex/A"
			if err := RegisterMailbox(env, "codex", "A", "host", "/work", os.Getpid(), live); err != nil {
				t.Fatal(err)
			}
			generation := transition(t, env, "execution-A", a)
			request := Request{MessageID: "pinned", Text: "durable pinned context"}
			if err := QueueFiberContext(env, "fiber", request); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending", mailboxKey(request.MessageID)+".json")
			entry, err := readFiberMailboxEntry(path)
			if err != nil {
				t.Fatal(err)
			}
			if err := writeFiberMailboxAttempt(path, entry, a); err != nil {
				t.Fatal(err)
			}
			_ = DeliverFiberContext(context.Background(), env, "fiber", "host", a, generation)
			if pendingMailboxText(t, env, "codex", "A", request.Text) {
				t.Error("quiet pinned context copied into session A queue")
			}
			entry, err = readFiberMailboxEntry(path)
			if err != nil {
				t.Fatal(err)
			}
			if !live && entry.AttemptAddress != a {
				t.Fatal("unavailable receiver lost pending attempt")
			}
			if err := RegisterMailbox(env, "codex", "B", "host", "/work", os.Getpid(), true); err != nil {
				t.Fatal(err)
			}
			const b = "shuttle://host/codex/B"
			generation = transition(t, env, "execution-B", b)
			_ = DeliverFiberContext(context.Background(), env, "fiber", "host", b, generation)
			var got []Request
			if err := OfferMailbox(env, "codex", "B", "host", func(batch []Request) error { got = append(got, batch...); return nil }); err != nil {
				t.Fatal(err)
			}
			if len(got) != 1 || got[0].Text != request.Text {
				t.Fatalf("successor hook context = %+v", got)
			}
			if n, err := PendingFiberContext(env, "fiber"); err != nil || n != 0 {
				t.Fatalf("pending = %d, %v", n, err)
			}
		})
	}
}

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
	if err := QueueFiberContext(env, "fiber", Request{MessageID: "wake", Text: "wake result", Wake: true}); err != nil {
		t.Fatal(err)
	}
	if err := DeliverFiberContext(context.Background(), env, "fiber", "host", address, generation); err != nil {
		t.Fatalf("wake failed: %v", err)
	}
	if n, err := PendingFiberContext(env, "fiber"); err != nil || n != 0 || inputs != 1 {
		t.Fatalf("pending=%d inputs=%d err=%v", n, inputs, err)
	}
}
