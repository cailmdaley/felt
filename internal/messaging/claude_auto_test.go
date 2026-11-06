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
				var delivered []Request
				if err := OfferMailbox(env, "claude", "session", "host", func(batch []Request) error { delivered = append(delivered, batch...); return nil }); err != nil {
					t.Fatal(err)
				}
				if len(delivered) != 1 || delivered[0].Text != req.Text {
					t.Fatalf("offered=%+v", delivered)
				}
				if err := RecoverClaudeMail(context.Background(), env, "host", time.Now().Add(time.Minute), nil); err != nil {
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

func TestClaudeUnofferedMailFallsBackAtThirtySecondsOrTurnEnd(t *testing.T) {
	for _, idle := range []bool{false, true} {
		t.Run(map[bool]string{false: "missing-stop", true: "idle"}[idle], func(t *testing.T) {
			env := testEnv(t)
			req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
			req.ContextIfBusy = true
			_ = SetMailboxState(env, "claude", "session", "host", "working")
			if _, err := Send(context.Background(), env, "host", req); err != nil {
				t.Fatal(err)
			}
			if err := RecoverClaudeMail(context.Background(), env.Clone(), "host", time.Now().Add(29*time.Second), nil); err != nil {
				t.Fatal(err)
			}
			if sent.Load() != 0 {
				t.Fatal("fell back before 30-second offer window")
			}
			at := time.Now().Add(31 * time.Second)
			if idle {
				_ = SetMailboxState(env, "claude", "session", "host", "idle")
				at = time.Now()
			}
			for i := 0; i < 2; i++ {
				if err := RecoverClaudeMail(context.Background(), env.Clone(), "host", at, nil); err != nil {
					t.Fatal(err)
				}
			}
			if err := OfferMailbox(env, "claude", "session", "host", func([]Request) error { t.Error("native mail also offered by hook"); return nil }); err != nil {
				t.Fatal(err)
			}
			receipt, err := Send(context.Background(), env, "host", req)
			if err != nil || receipt.Transport != "claude-native" || sent.Load() != 1 {
				t.Fatalf("receipt=%+v native=%d err=%v", receipt, sent.Load(), err)
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
			if err := RecoverClaudeMail(context.Background(), env, "host", time.Now().Add(time.Minute), nil); err != nil {
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
		t.Fatalf("native duplicated hook offer: %d", sent.Load())
	}
}

func TestClaudePassiveContextNeverFallsBack(t *testing.T) {
	env := testEnv(t)
	req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
	req.Wake = false
	if _, err := Send(context.Background(), env, "host", req); err != nil {
		t.Fatal(err)
	}
	if err := RecoverClaudeMail(context.Background(), env, "host", time.Now().Add(time.Minute), nil); err != nil {
		t.Fatal(err)
	}
	if pending, err := ClaudeMailPending(env); err != nil || pending {
		t.Fatalf("passive mail schedules recovery: %v %v", pending, err)
	}
	if sent.Load() != 0 || !pendingMailboxText(t, env, "claude", "session", req.Text) {
		t.Fatal("passive mail woke receiver or was lost")
	}
}

func TestClaudeFallbackPreflightReturnsMailToHook(t *testing.T) {
	env := testEnv(t)
	req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
	req.ContextIfBusy = true
	_ = SetMailboxState(env, "claude", "session", "host", "working")
	if _, err := Send(context.Background(), env, "host", req); err != nil {
		t.Fatal(err)
	}
	native := filepath.Join(mailboxDir(env, "claude", "session"), "native.json")
	if err := os.Remove(native); err != nil {
		t.Fatal(err)
	}
	if err := RecoverClaudeMail(context.Background(), env, "host", time.Now().Add(time.Minute), nil); err != nil {
		t.Fatal(err)
	}
	offered := 0
	if err := OfferMailbox(env, "claude", "session", "host", func(requests []Request) error { offered += len(requests); return nil }); err != nil {
		t.Fatal(err)
	}
	if err := RecoverClaudeMail(context.Background(), env, "host", time.Now().Add(time.Minute), nil); err != nil {
		t.Fatal(err)
	}
	if sent.Load() != 0 || offered != 1 {
		t.Fatalf("writes=%d hook offers=%d", sent.Load(), offered)
	}
}
