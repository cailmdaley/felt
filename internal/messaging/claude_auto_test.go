package messaging

import (
	"context"
	"os"
	"testing"
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
