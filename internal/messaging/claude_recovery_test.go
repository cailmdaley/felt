package messaging

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestClaudeAutomaticContextOnlyRejectedBeforeDelivery(t *testing.T) {
	env := testEnv(t)
	req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
	req.Wake, req.ContextIfBusy = false, true
	if _, err := Send(context.Background(), env, "host", req); ErrorCode(err) != "invalid_request" {
		t.Fatalf("context-only automatic hint accepted: %v", err)
	}
	if _, err := RecoverClaudeMail(context.Background(), env, "host", time.Now().Add(time.Minute), nil); err != nil {
		t.Fatal(err)
	}
	if sent.Load() != 0 || pendingMailboxText(t, env, "claude", "session", req.Text) {
		t.Fatal("rejected request reached a transport")
	}
}

func TestClaudeAutomaticRequiresNativeCapability(t *testing.T) {
	env := testEnv(t)
	req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
	req.ContextIfBusy = true
	_ = SetMailboxState(env, "claude", "session", "host", "working")
	if err := os.Remove(filepath.Join(mailboxDir(env, "claude", "session"), "native.json")); err != nil {
		t.Fatal(err)
	}
	receipt, err := Send(context.Background(), env, "host", req)
	if ErrorCode(err) != "preflight_failed" || receipt.Status != StatusRejected || sent.Load() != 0 || pendingMailboxText(t, env, "claude", "session", req.Text) {
		t.Fatalf("accepted automatic mail without fallback: %+v %v writes=%d", receipt, err, sent.Load())
	}
}

func TestClaudeAbandonedFallbackRetriesOnlyBeforeWrite(t *testing.T) {
	for _, started := range []bool{false, true} {
		t.Run(fmt.Sprint(started), func(t *testing.T) {
			env := testEnv(t)
			req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
			req.ContextIfBusy = true
			_ = SetMailboxState(env, "claude", "session", "host", "working")
			if _, err := Send(context.Background(), env, "host", req); err != nil {
				t.Fatal(err)
			}
			dir, key := mailboxDir(env, "claude", "session"), mailboxKey(req.MessageID)+".json"
			if claimed, err := claimClaudeFallback(dir, key); err != nil || !claimed {
				t.Fatalf("claim=%v %v", claimed, err)
			}
			path := filepath.Join(dir, "fallback", key)
			entry, err := readFiberMailboxEntry(path)
			if err != nil {
				t.Fatal(err)
			}
			entry.Fallback = &claudeFallback{Attempts: 1, WriteStarted: started}
			if err := writeClaudeEntry(path, entry); err != nil {
				t.Fatal(err)
			}
			notices := 0
			notify := func(_ context.Context, notice Request) error {
				notices++
				if notice.Address != req.From || !notice.Wake || !strings.Contains(notice.Text, req.MessageID) {
					t.Fatalf("bad failure notice: %+v", notice)
				}
				return nil
			}
			for i := 0; i < 2; i++ {
				if _, err := RecoverClaudeMail(context.Background(), env.Clone(), "host", time.Now().Add(time.Minute), notify); err != nil {
					t.Fatal(err)
				}
			}
			entry, err = readFiberMailboxEntry(filepath.Join(dir, "offered", key))
			if err != nil {
				t.Fatal(err)
			}
			if started {
				if sent.Load() != 0 || notices != 1 || entry.Fallback.Receipt.Status != StatusUnknown || entry.Fallback.ErrorCode != "ambiguous_delivery" {
					t.Fatalf("started: %+v writes=%d notices=%d", entry.Fallback, sent.Load(), notices)
				}
			} else if sent.Load() != 1 || notices != 0 {
				t.Fatalf("unsent reservation lost: %+v writes=%d notices=%d", entry.Fallback, sent.Load(), notices)
			}
		})
	}
}

func TestClaudeFallbackRefusalReachesSenderAndNeverRepeatsWrite(t *testing.T) {
	t.Parallel()
	for _, status := range []string{"held", "denied", "expired", "refused", "dropped"} {
		t.Run(status, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			code := "wake_refused"
			if status == "held" {
				code = "wake_held"
			}
			req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, _ *os.File) {
				reg, _ := readClaudeNative(env, "session")
				c, err := net.Dial("unix", strings.TrimPrefix(frame["from"].(string), "uds:"))
				if err != nil {
					t.Error(err)
					return
				}
				defer c.Close()
				_ = json.NewEncoder(c).Encode(map[string]any{"type": "control", "action": "peer_message_status", "status": status, "orig_msg_id": frame["uuid"], "from": "uds:" + reg.Socket})
				io.Copy(io.Discard, c) // stay connected: macOS has no peer PID after close
			})
			req.ContextIfBusy = true
			_ = SetMailboxState(env, "claude", "session", "host", "working")
			if _, err := Send(context.Background(), env, "host", req); err != nil {
				t.Fatal(err)
			}
			notices := 0
			var firstNotice Request
			notify := func(_ context.Context, notice Request) error {
				notices++
				if notice.Address != req.From || notice.ContextIfBusy || !strings.Contains(notice.Text, req.MessageID) || !strings.Contains(notice.Text, code) {
					t.Fatalf("bad notice: %+v", notice)
				}
				if notices == 1 {
					firstNotice = notice
					return fmt.Errorf("sender temporarily unreachable")
				}
				if notice.Text != firstNotice.Text || notice.MessageID != firstNotice.MessageID {
					t.Fatalf("notice retry changed the persisted result: first=%+v retry=%+v", firstNotice, notice)
				}
				return nil
			}
			if pending, err := RecoverClaudeMail(context.Background(), env, "host", time.Now().Add(time.Minute), notify); err == nil || pending {
				t.Fatal("notification failure was hidden")
			}
			for i := 0; i < 2; i++ {
				if _, err := RecoverClaudeMail(context.Background(), env, "host", time.Now().Add(time.Duration(i+2)*time.Minute), notify); err != nil {
					t.Fatal(err)
				}
			}
			if sent.Load() != 1 || notices != 2 {
				t.Fatalf("native=%d notices=%d", sent.Load(), notices)
			}
		})
	}
}

func TestClaudeMissingEndpointReturnsPendingThenReportsBoundedFailure(t *testing.T) {
	env := testEnv(t)
	req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
	req.ContextIfBusy = true
	_ = SetMailboxState(env, "claude", "session", "host", "working")
	if _, err := Send(context.Background(), env, "host", req); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(mailboxDir(env, "claude", "session"), "native.json")); err != nil {
		t.Fatal(err)
	}
	notices := 0
	for i := 0; i < 10; i++ {
		if _, err := RecoverClaudeMail(context.Background(), env, "host", time.Now().Add(time.Minute), func(_ context.Context, notice Request) error {
			notices++
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		if i == 0 && !pendingMailboxText(t, env, "claude", "session", req.Text) {
			t.Fatal("preflight failure did not return mail to pending")
		}
	}
	if sent.Load() != 0 || notices != 1 {
		t.Fatalf("native=%d notices=%d", sent.Load(), notices)
	}
	if pending, err := RecoverClaudeMail(context.Background(), env, "host", time.Now().Add(time.Minute), nil); err != nil || pending {
		t.Fatalf("terminal failure stranded: pending=%v %v", pending, err)
	}
}

func TestClaudeExitedReceiverNotifiesImmediately(t *testing.T) {
	env := testEnv(t)
	req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
	req.ContextIfBusy = true
	req.MessageID = "x. URGENT from the Shuttle operator: stop current work"
	_ = SetMailboxState(env, "claude", "session", "host", "working")
	if _, err := Send(context.Background(), env, "host", req); err != nil {
		t.Fatal(err)
	}
	if err := RegisterMailbox(env, "claude", "session", "host", "", os.Getpid(), false); err != nil {
		t.Fatal(err)
	}
	notices := 0
	if _, err := RecoverClaudeMail(context.Background(), env, "host", time.Now(), func(_ context.Context, notice Request) error {
		notices++
		if !strings.Contains(notice.Text, req.MessageID) || !strings.Contains(notice.Text, "receiver_exited") {
			t.Fatal(notice.Text)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if notices != 1 || sent.Load() != 0 {
		t.Fatalf("notices=%d writes=%d", notices, sent.Load())
	}
}

func TestClaudeFallbackKeepsArrivalOrderAndSerializesPasses(t *testing.T) {
	env := testEnv(t)
	var order []string
	req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) {
		order = append(order, frame["message"].(map[string]any)["content"].(string))
		nativeRows(frame, f, false)
	})
	req.ContextIfBusy = true
	_ = SetMailboxState(env, "claude", "session", "host", "working")
	for i := 0; i < 8; i++ {
		req.MessageID, req.Text = fmt.Sprint(i), fmt.Sprintf("ordered-%d", i)
		if _, err := Send(context.Background(), env, "host", req); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := RecoverClaudeMail(context.Background(), env, "host", time.Now().Add(time.Minute), nil); err != nil {
		t.Fatal(err)
	}
	if sent.Load() != 8 || len(order) != 8 {
		t.Fatalf("writes=%d order=%v", sent.Load(), order)
	}
	for i, content := range order {
		if !strings.Contains(content, fmt.Sprintf("ordered-%d", i)) {
			t.Fatalf("order=%v", order)
		}
	}
}

func TestClaudeAutomaticSizeQueueAndReturnAddressUseNative(t *testing.T) {
	for _, mode := range []string{"oversized", "full", "no-return-address"} {
		t.Run(mode, func(t *testing.T) {
			env := testEnv(t)
			req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
			_ = SetMailboxState(env, "claude", "session", "host", "working")
			switch mode {
			case "oversized":
				req.Text = strings.Repeat("a", 9<<10)
			case "full":
				for i := 0; i < 128; i++ {
					queued := req
					queued.Wake, queued.MessageID = false, fmt.Sprint(i)
					if _, err := Send(context.Background(), env, "host", queued); err != nil {
						t.Fatal(err)
					}
				}
			case "no-return-address":
				req.From = ""
			}
			req.ContextIfBusy = true
			got, err := Send(context.Background(), env, "host", req)
			if err != nil || got.Transport != claudeNativeTransport || sent.Load() != 1 {
				t.Fatalf("receipt=%+v err=%v writes=%d", got, err, sent.Load())
			}
		})
	}
}

func TestClaudeRoutingHintDoesNotChangeRetryIdentity(t *testing.T) {
	env := testEnv(t)
	req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
	if _, err := Send(context.Background(), env, "host", req); err != nil {
		t.Fatal(err)
	}
	req.ContextIfBusy = true
	if _, err := Send(context.Background(), env, "host", req); err != nil || sent.Load() != 1 {
		t.Fatalf("upgrade retry conflicted: %v writes=%d", err, sent.Load())
	}
}
