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

func TestClaudeFailedNoticesAreBoundedAndWaitForSweep(t *testing.T) {
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
	calls := 0
	notify := func(ctx context.Context, notice Request) error {
		calls++
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > 5*time.Second {
			t.Error("notice has no five-second deadline")
		}
		return fmt.Errorf("sender gone")
	}
	now := time.Now().Add(time.Minute)
	for i := 0; i < 10; i++ {
		_, _ = RecoverClaudeMail(context.Background(), env, "host", now.Add(time.Duration(i)*time.Second), notify)
	}
	if calls != 1 {
		t.Fatalf("notice retried before sweep: %d", calls)
	}
	if pending, err := RecoverClaudeMail(context.Background(), env, "host", now.Add(10*time.Second), notify); err != nil || pending {
		t.Fatalf("notice-only entry schedules fast recovery: %v %v", pending, err)
	}
	for i := 1; i < 8; i++ {
		_, _ = RecoverClaudeMail(context.Background(), env, "host", now.Add(time.Duration(i)*time.Minute), notify)
	}
	if calls != 3 || sent.Load() != 0 {
		t.Fatalf("notice retries=%d native=%d", calls, sent.Load())
	}
	dir := mailboxDir(env, "claude", "session")
	if _, err := os.Stat(filepath.Join(dir, "offered", mailboxKey(req.MessageID)+".json")); err != nil {
		t.Fatal("terminal notice was not retired:", err)
	}
}

func TestClaudeHangingNoticeCannotStarveOtherMail(t *testing.T) {
	env := testEnv(t)
	req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
	req.ContextIfBusy = true
	_ = SetMailboxState(env, "claude", "session", "host", "working")
	req.MessageID, req.Text = "old-failure", "old failure"
	if _, err := Send(context.Background(), env, "host", req); err != nil {
		t.Fatal(err)
	}
	dir, key := mailboxDir(env, "claude", "session"), mailboxKey(req.MessageID)+".json"
	if claimed, err := claimClaudeFallback(dir, key); !claimed || err != nil {
		t.Fatal(claimed, err)
	}
	path := filepath.Join(dir, "fallback", key)
	entry, err := readFiberMailboxEntry(path)
	if err != nil {
		t.Fatal(err)
	}
	receipt := rejected(req, "claude-native", "receiver refused")
	entry.Fallback = &claudeFallback{WriteStarted: true, Receipt: &receipt, ErrorCode: "refused", ErrorMessage: "receiver refused"}
	if err := writeClaudeEntry(path, entry); err != nil {
		t.Fatal(err)
	}
	req.MessageID, req.Text = "young-mail", "young mail"
	if _, err := Send(context.Background(), env, "host", req); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Add(time.Minute)
	for i := 0; i < 2; i++ {
		// The notice hangs until the pass itself runs out of time.
		ctx, cancel := context.WithCancel(context.Background())
		notify := func(noticeCtx context.Context, _ Request) error { cancel(); <-noticeCtx.Done(); return noticeCtx.Err() }
		_, _ = RecoverClaudeMail(ctx, env, "host", now.Add(time.Duration(i)*time.Second), notify)
		cancel()
	}
	if sent.Load() != 1 {
		t.Fatalf("younger mail starved: writes=%d", sent.Load())
	}
}

func TestClaudeUnreadableEntryDoesNotBlockHealthyMail(t *testing.T) {
	env := testEnv(t)
	req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
	req.ContextIfBusy = true
	_ = SetMailboxState(env, "claude", "session", "host", "working")
	if _, err := Send(context.Background(), env, "host", req); err != nil {
		t.Fatal(err)
	}
	bad := filepath.Join(dataDir(env), "mailboxes", "claude", "aaa", "pending")
	if err := os.MkdirAll(bad, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bad, "bad.json"), []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	pending, err := RecoverClaudeMail(context.Background(), env, "host", time.Now().Add(time.Minute), nil)
	if pending {
		t.Fatal("unreadable entry schedules fast recovery")
	}
	if sent.Load() != 1 {
		t.Fatalf("corrupt entry stopped healthy mail: writes=%d error=%v", sent.Load(), err)
	}
	if err == nil {
		t.Fatal("skipped entry had no diagnostic")
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
