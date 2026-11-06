package messaging

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestClaudeQueuePublicationErrorDoesNotChangeTransports(t *testing.T) {
	env := testEnv(t)
	req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
	req.ContextIfBusy = true
	_ = SetMailboxState(env, "claude", "session", "host", "working")
	queued := req
	queued.Wake = false
	// A published entry with no sender receipt models an EEXIST replay or a
	// post-publication durability failure, without needing an NFS mount.
	if err := enqueueMailbox(mailboxDir(env, "claude", "session"), queued); err != nil {
		t.Fatal(err)
	}
	got, err := Send(context.Background(), env, "host", req)
	if ErrorCode(err) != "ambiguous_delivery" || got.Status != StatusUnknown || sent.Load() != 0 {
		t.Fatalf("publication error caused a native duplicate: %+v %v writes=%d", got, err, sent.Load())
	}
	offered := 0
	if err := OfferMailbox(env, "claude", "session", "host", func(batch []Request) error { offered += len(batch); return nil }); err != nil {
		t.Fatal(err)
	}
	if offered != 1 || sent.Load() != 0 {
		t.Fatalf("hook=%d native=%d", offered, sent.Load())
	}
}

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
				if err := QueueFiberContext(env, "fiber", Request{MessageID: fmt.Sprint(i), Text: body}); err != nil {
					t.Fatal(err)
				}
			}
			if err := DeliverFiberContext(context.Background(), env, "fiber", "host", address, generation); err != nil {
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

func TestClaudeRecoveryPassesNeverOverlap(t *testing.T) {
	env := testEnv(t)
	received, release := make(chan struct{}), make(chan struct{})
	req, sent := nativeClaudeFixture(t, env, func(_ map[string]any, _ *os.File) { close(received); <-release })
	defer close(release)
	req.ContextIfBusy = true
	_ = SetMailboxState(env, "claude", "session", "host", "working")
	if _, err := Send(context.Background(), env, "host", req); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- RecoverClaudeMail(ctx, env, "host", time.Now().Add(time.Minute), nil) }()
	select {
	case <-received:
	case <-time.After(5 * time.Second):
		t.Fatal("native write never started")
	}
	if err := RecoverClaudeMail(context.Background(), env.Clone(), "host", time.Now().Add(time.Minute), nil); err != nil {
		t.Fatal(err)
	}
	if sent.Load() != 1 {
		t.Fatalf("overlapping write: %d", sent.Load())
	}
	cancel()
	<-done
}
