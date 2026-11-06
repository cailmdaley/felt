package messaging

import (
	"context"
	"os"
	"path/filepath"
	"sync"
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
				var delivered []Request
				if err := OfferMailbox(env, "claude", "session", "host", func(batch []Request) error { delivered = append(delivered, batch...); return nil }); err != nil {
					t.Fatal(err)
				}
				if len(delivered) != 1 || delivered[0].Text != req.Text {
					t.Fatalf("offered=%+v", delivered)
				}
				if err := RecoverClaudeMail(context.Background(), env, "host", time.Now().Add(time.Minute)); err != nil {
					t.Fatal(err)
				}
				again, err := Send(context.Background(), env, "host", req)
				if err != nil || again.Status != StatusContextAdded || sent.Load() != 0 {
					t.Fatalf("retry=%+v native=%d err=%v", again, sent.Load(), err)
				}
			} else if sent.Load() != 1 {
				t.Fatalf("native sends=%d", sent.Load())
			}
		})
	}
}

// A final tool, API failure, interrupt, or missing Stop can all leave the
// registration working forever. None may prevent an ordinary message waking it.
func TestClaudeUnofferedMailFallsBackWithoutLifecycleEvidence(t *testing.T) {
	for _, end := range []string{"last-tool", "api-failure", "interrupt", "daemon-restart"} {
		t.Run(end, func(t *testing.T) {
			env := testEnv(t)
			req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
			req.ContextIfBusy = true
			if err := SetMailboxState(env, "claude", "session", "host", "working"); err != nil {
				t.Fatal(err)
			}
			if receipt, err := Send(context.Background(), env, "host", req); err != nil || receipt.Status != StatusQueued {
				t.Fatalf("queued=%+v %v", receipt, err)
			}
			if end == "interrupt" {
				_ = SetMailboxState(env, "claude", "session", "host", "idle")
			}
			// Recovery reads only disk; no original sender or in-memory timer survives.
			recovered := env.Clone()
			if err := RecoverClaudeMail(context.Background(), recovered, "host", time.Now()); err != nil {
				t.Fatal(err)
			}
			if sent.Load() != 0 {
				t.Fatal("fallback before the offer window expired")
			}
			for i := 0; i < 2; i++ {
				if err := RecoverClaudeMail(context.Background(), recovered, "host", time.Now().Add(time.Minute)); err != nil {
					t.Fatal(err)
				}
			}
			offered := 0
			if err := OfferMailbox(env, "claude", "session", "host", func(rs []Request) error { offered += len(rs); return nil }); err != nil {
				t.Fatal(err)
			}
			receipt, err := Send(context.Background(), env, "host", req)
			if err != nil || receipt.Transport != "claude-native" || receipt.Status != StatusAccepted || sent.Load() != 1 || offered != 0 {
				t.Fatalf("receipt=%+v native=%d hook=%d err=%v", receipt, sent.Load(), offered, err)
			}
		})
	}
}

func TestClaudeFallbackAndHookCannotBothDeliver(t *testing.T) {
	env := testEnv(t)
	req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
	req.ContextIfBusy = true
	_ = SetMailboxState(env, "claude", "session", "host", "working")
	if _, err := Send(context.Background(), env, "host", req); err != nil {
		t.Fatal(err)
	}
	emitting, release, done := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	go func() {
		done <- OfferMailbox(env, "claude", "session", "host", func([]Request) error { close(emitting); <-release; return nil })
	}()
	<-emitting
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := RecoverClaudeMail(context.Background(), env, "host", time.Now().Add(time.Minute)); err != nil {
				t.Error(err)
			}
		}()
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	wg.Wait()
	if sent.Load() != 0 {
		t.Fatalf("native duplicated a hook offer: %d", sent.Load())
	}
}

func TestClaudePassiveContextNeverFallsBack(t *testing.T) {
	env := testEnv(t)
	req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
	req.Wake = false
	if _, err := Send(context.Background(), env, "host", req); err != nil {
		t.Fatal(err)
	}
	if err := RecoverClaudeMail(context.Background(), env, "host", time.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if sent.Load() != 0 {
		t.Fatal("context-only woke receiver")
	}
	if !pendingMailboxText(t, env, "claude", "session", req.Text) {
		t.Fatal("passive mail lost")
	}
}

func TestClaudeFallbackPreflightCanRetryButCannotReachHook(t *testing.T) {
	env := testEnv(t)
	req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
	req.ContextIfBusy = true
	_ = SetMailboxState(env, "claude", "session", "host", "working")
	if _, err := Send(context.Background(), env, "host", req); err != nil {
		t.Fatal(err)
	}
	native := filepath.Join(mailboxDir(env, "claude", "session"), "native.json")
	registration, err := os.ReadFile(native)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(native); err != nil {
		t.Fatal(err)
	}
	if err := RecoverClaudeMail(context.Background(), env, "host", time.Now().Add(time.Minute)); err == nil {
		t.Fatal("missing native registration must report failure")
	}
	if err := OfferMailbox(env, "claude", "session", "host", func([]Request) error { t.Error("claimed mail reached hook"); return nil }); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(native, registration, 0600); err != nil {
		t.Fatal(err)
	}
	if err := RecoverClaudeMail(context.Background(), env, "host", time.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if sent.Load() != 1 {
		t.Fatalf("native=%d", sent.Load())
	}
}
