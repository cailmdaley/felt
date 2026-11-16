package messaging

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClaudeFiberContextFitsReceiverBudgetAndRetainsOversizedBody(t *testing.T) {
	for _, oversized := range []bool{false, true} {
		t.Run(fmt.Sprint(oversized), func(t *testing.T) {
			env := testEnv(t)
			if err := RegisterMailbox(env, "claude", "session", "host", "/work", os.Getpid(), true); err != nil {
				t.Fatal(err)
			}
			address := "shuttle://host/claude/session"
			generation, err := TransitionFiberReceiver(env, "fiber", "host", "execution", address)
			if err != nil {
				t.Fatal(err)
			}
			count, body := 4, strings.Repeat("a", 3000)
			if oversized {
				count, body = 1, strings.Repeat("x", 20<<10)+"FULL_TAIL"
			}
			for i := 0; i < count; i++ {
				if err := Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: fmt.Sprint(i), Text: body}}); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := Consume(context.Background(), env, "fiber", "host", Worker{Address: address, Epoch: generation}); err != nil {
				t.Fatal(err)
			}
			offered := 0
			for hook := 0; hook < count; hook++ {
				err := OfferMailbox(env, "claude", "session", "host", func(batch []Request) error {
					size := 0
					for _, req := range batch {
						size += len(Labeled(req)) + 2
						offered++
						if oversized {
							prefix := "Full message JSON (read request.text before acting): "
							if !strings.HasPrefix(req.Text, prefix) {
								t.Fatalf("unbounded fiber body: %d bytes", len(req.Text))
							}
						}
					}
					if size > claudeHookBatchBytes {
						t.Fatalf("hook body has %d bytes", size)
					}
					return nil
				})
				if err != nil {
					t.Fatal(err)
				}
			}
			if offered != count {
				t.Fatalf("offers=%d want=%d", offered, count)
			}
			if oversized {
				path := filepath.Join(mailboxDir(env, "fiber", "fiber"), "offered", mailboxKey("0")+".json")
				entry, err := readFiberMailboxEntry(path)
				if err != nil || entry.Request.Text != body {
					t.Fatalf("full fiber body not retained: %v", err)
				}
			}
		})
	}
}
