package messaging

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestClaudeContextIfBusy(t *testing.T) {
	for _, tc := range []struct {
		name, state   string
		auto          bool
		wantTransport string
	}{
		{"busy", "working", true, "claude-hook"},
		{"idle", "idle", true, "claude-native"},
		{"unknown", "", true, "claude-native"},
		{"forced wake", "working", false, "claude-native"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := testEnv(t)
			req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
			req.ContextIfBusy = tc.auto
			if tc.state != "" {
				if err := SetMailboxState(env, "claude", "session", "host", tc.state); err != nil {
					t.Fatal(err)
				}
			}
			receipt, err := Send(context.Background(), env, "host", req)
			if err != nil || receipt.Transport != tc.wantTransport {
				t.Fatalf("receipt=%+v err=%v", receipt, err)
			}
			if tc.wantTransport == "claude-hook" {
				if receipt.Status != StatusQueued || sent.Load() != 0 {
					t.Fatalf("receipt=%+v native sends=%d", receipt, sent.Load())
				}
				if err := SetMailboxState(env, "claude", "session", "host", "idle"); err != nil {
					t.Fatal(err)
				}
				again, err := Send(context.Background(), env, "host", req)
				if err != nil || again.Transport != "claude-hook" || sent.Load() != 0 {
					t.Fatalf("retry=%+v err=%v", again, err)
				}
				var delivered []Request
				if err := OfferMailbox(env, "claude", "session", "host", func(batch []Request) error { delivered = append(delivered, batch...); return nil }); err != nil {
					t.Fatal(err)
				}
				if len(delivered) != 1 || delivered[0].Text != req.Text {
					t.Fatalf("offered=%+v", delivered)
				}
			} else if sent.Load() != 1 {
				t.Fatalf("native sends=%d", sent.Load())
			}
		})
	}
}

func TestBusyClaudeDeathDoesNotKeepQueuedReceipt(t *testing.T) {
	env := testEnv(t)
	child := exec.Command("sleep", "60")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer child.Process.Kill()
	if err := RegisterMailbox(env, "claude", "s", "host", "/", child.Process.Pid, true); err != nil {
		t.Fatal(err)
	}
	if err := SetMailboxState(env, "claude", "s", "host", "working"); err != nil {
		t.Fatal(err)
	}
	req := Request{Address: "shuttle://host/claude/s", Text: "late", MessageID: "late", Wake: true, ContextIfBusy: true}
	receipt, err := Send(context.Background(), env, "host", req)
	if err != nil || receipt.Status != StatusQueued {
		t.Fatalf("send=%+v %v", receipt, err)
	}
	_ = child.Process.Kill()
	_ = child.Wait()
	receipt, err = Send(context.Background(), env, "host", req)
	if receipt.Status != StatusUnknown || ErrorCode(err) != "receiver_exited" {
		t.Fatalf("retry=%+v %v", receipt, err)
	}
	req.MessageID = "after-death"
	receipt, err = Send(context.Background(), env, "host", req)
	if err == nil || receipt.Status == StatusQueued {
		t.Fatalf("dead receiver send=%+v %v", receipt, err)
	}
}

func TestClaudeStopWaitsForConcurrentOffer(t *testing.T) {
	env := testEnv(t)
	if err := RegisterMailbox(env, "claude", "s", "host", "/", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	if err := SetMailboxState(env, "claude", "s", "host", "working"); err != nil {
		t.Fatal(err)
	}
	req := Request{Address: "shuttle://host/claude/s", Text: "earlier", MessageID: "earlier"}
	if _, err := Send(context.Background(), env, "host", req); err != nil {
		t.Fatal(err)
	}
	emitting, release, offered := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	go func() {
		offered <- OfferMailbox(env, "claude", "s", "host", func([]Request) error { close(emitting); <-release; return nil })
	}()
	<-emitting
	req.Text, req.MessageID, req.Wake, req.ContextIfBusy = "late", "late", true, true
	if _, err := Send(context.Background(), env, "host", req); err != nil {
		close(release)
		t.Fatal(err)
	}
	type result struct {
		continued bool
		err       error
	}
	finished := make(chan result, 1)
	go func() {
		continued, err := FinishClaudeMailbox(env, "s", "host", time.Now().UnixMilli(), func(batch []Request) error {
			if len(batch) != 1 || batch[0].Text != "late" {
				return fmt.Errorf("unexpected Stop batch: %+v", batch)
			}
			return nil
		})
		finished <- result{continued, err}
	}()
	select {
	case got := <-finished:
		close(release)
		t.Fatalf("Stop skipped a locked mailbox: %+v", got)
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	if err := <-offered; err != nil {
		t.Fatal(err)
	}
	got := <-finished
	if !got.continued || got.err != nil {
		t.Fatalf("Stop=%+v", got)
	}
}
