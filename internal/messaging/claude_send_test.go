package messaging

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A Claude session message that asks for a turn goes to the native socket in
// every turn state, whatever its size, the session inbox's fill or the sender's
// return address, and a retry of its id writes nothing more.
func TestClaudeAskGoesNative(t *testing.T) {
	for _, tc := range []struct{ name, state, mode string }{
		{"busy", "working", ""},
		{"idle", "idle", ""},
		{"unknown", "", ""},
		{"busy oversized", "working", "oversized"},
		{"busy full inbox", "working", "full"},
		{"busy without return address", "working", "no-return-address"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := testEnv(t)
			req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
			if tc.state != "" {
				if err := SetMailboxState(env, "claude", "session", "host", tc.state); err != nil {
					t.Fatal(err)
				}
			}
			switch tc.mode {
			case "oversized":
				req.Text = strings.Repeat("a", 9<<10)
			case "full":
				for i := 0; i < 128; i++ {
					queued := req
					queued.Wake, queued.MessageID, queued.Text = false, fmt.Sprint(i), fmt.Sprint("filler ", i)
					if _, err := Send(context.Background(), env, "host", queued); err != nil {
						t.Fatal(err)
					}
				}
			case "no-return-address":
				req.From = ""
			}
			req.ContextIfBusy = true
			receipt, err := Send(context.Background(), env, "host", req)
			if err != nil || receipt.Transport != claudeNativeTransport || sent.Load() != 1 {
				t.Fatalf("receipt=%+v err=%v writes=%d", receipt, err, sent.Load())
			}
			if pendingMailboxText(t, env, "claude", "session", req.Text) {
				t.Fatal("a native send also left the message for the hook")
			}
			if _, err := Send(context.Background(), env, "host", req); err != nil || sent.Load() != 1 {
				t.Fatalf("retry: %v writes=%d", err, sent.Load())
			}
		})
	}
}

func TestClaudeContextIfBusyRequiresWake(t *testing.T) {
	env := testEnv(t)
	req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
	req.Wake, req.ContextIfBusy = false, true
	if _, err := Send(context.Background(), env, "host", req); ErrorCode(err) != "invalid_request" {
		t.Fatalf("context_if_busy without wake accepted: %v", err)
	}
	if sent.Load() != 0 || pendingMailboxText(t, env, "claude", "session", req.Text) {
		t.Fatal("rejected request reached a transport")
	}
}

// A busy session without a native endpoint refuses the ask before writing,
// rather than keeping it as hook context.
func TestClaudeAskWithoutNativeEndpointIsRefused(t *testing.T) {
	env := testEnv(t)
	req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
	req.ContextIfBusy = true
	_ = SetMailboxState(env, "claude", "session", "host", "working")
	if err := os.Remove(filepath.Join(mailboxDir(env, "claude", "session"), "native.json")); err != nil {
		t.Fatal(err)
	}
	receipt, err := Send(context.Background(), env, "host", req)
	if ErrorCode(err) != "preflight_failed" || receipt.Status != StatusRejected || sent.Load() != 0 || pendingMailboxText(t, env, "claude", "session", req.Text) {
		t.Fatalf("receipt=%+v err=%v writes=%d", receipt, err, sent.Load())
	}
}

// An ask to a session that has ended is refused as unavailable before
// anything is written, though its native endpoint is still registered, and
// leaves nothing for a hook.
func TestClaudeAskToAnEndedSessionIsRefused(t *testing.T) {
	env := testEnv(t)
	req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
	req.ContextIfBusy = true
	if err := RegisterMailbox(env, "claude", "session", "host", "", os.Getpid(), false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(mailboxDir(env, "claude", "session"), "native.json")); err != nil {
		t.Fatal(err)
	}
	receipt, err := Send(context.Background(), env, "host", req)
	if ErrorCode(err) != "unavailable" || receipt.Status != StatusRejected || sent.Load() != 0 || pendingMailboxText(t, env, "claude", "session", req.Text) {
		t.Fatalf("receipt=%+v err=%v writes=%d", receipt, err, sent.Load())
	}
}

// A busy session's approval policy answers the sender directly, and a retry
// of the id writes nothing more.
func TestClaudeNativeRefusalAnswersTheSender(t *testing.T) {
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
			for i := 0; i < 2; i++ {
				if _, err := Send(context.Background(), env, "host", req); ErrorCode(err) != code {
					t.Fatalf("send %d: %v, want %s", i, err, code)
				}
			}
			if sent.Load() != 1 || pendingMailboxText(t, env, "claude", "session", req.Text) {
				t.Fatalf("writes=%d", sent.Load())
			}
		})
	}
}

// A hook emission that failed leaves its claim and its entry pending in the
// Claude session's mailbox, and when the session then ends nothing sends the
// entry.
func TestAFailedHookClaimStaysAndNothingSendsItsEntryWhenTheSessionEnds(t *testing.T) {
	env := testEnv(t)
	req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
	req.Wake = false
	if _, err := Send(context.Background(), env, "host", req); err != nil {
		t.Fatal(err)
	}
	dir := mailboxDir(env, "claude", "session")
	lost := errors.New("hook output lost")
	if err := offerMailboxWithAck(dir, req.Address, func(Request) bool { return true }, func([]Request) error { return lost }, nil, "claude"); !errors.Is(err, lost) {
		t.Fatalf("offer = %v", err)
	}
	if err := RegisterMailbox(env, "claude", "session", "host", "", os.Getpid(), false); err != nil {
		t.Fatal(err)
	}
	if claims, err := readBatchManifests(dir); err != nil || len(claims) != 1 || !claims[0].Hook {
		t.Fatalf("claims = %+v %v", claims, err)
	}
	if sent.Load() != 0 || !pendingMailboxText(t, env, "claude", "session", req.Text) {
		t.Fatalf("writes=%d", sent.Load())
	}
}

// A message that asks for no turn waits for the session's hook.
func TestClaudePassiveContextWaitsForTheHook(t *testing.T) {
	env := testEnv(t)
	req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
	req.Wake = false
	_ = SetMailboxState(env, "claude", "session", "host", "working")
	receipt, err := Send(context.Background(), env, "host", req)
	if err != nil || receipt.Transport != "claude-hook" || receipt.Status != StatusQueued {
		t.Fatalf("receipt=%+v err=%v", receipt, err)
	}
	if sent.Load() != 0 || !pendingMailboxText(t, env, "claude", "session", req.Text) {
		t.Fatal("passive mail woke receiver or was lost")
	}
}

func TestClaudeLargePassiveMailOffersRetainedReference(t *testing.T) {
	env := testEnv(t)
	req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
	req.Wake = false
	req.Text = strings.Repeat("x", 9000) + "FULL_TAIL"
	if _, err := Send(context.Background(), env, "host", req); err != nil {
		t.Fatal(err)
	}
	offered := 0
	err := OfferMailbox(env, "claude", "session", "host", func(batch []Request) error {
		offered += len(batch)
		if len(batch) != 1 || !strings.HasPrefix(batch[0].Text, "Full message JSON") || len(Labeled(batch[0])) > claudeHookBatchBytes {
			t.Fatalf("unsafe offer: %+v", batch)
		}
		return nil
	})
	if err != nil || offered != 1 || sent.Load() != 0 {
		t.Fatal(err, offered, sent.Load())
	}
	path := filepath.Join(mailboxDir(env, "claude", "session"), "offered", mailboxKey(req.MessageID)+".json")
	entry, err := readFiberMailboxEntry(path)
	if err != nil || entry.Request.Text != req.Text {
		t.Fatal("full message not retained", err)
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
