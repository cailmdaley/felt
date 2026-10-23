package messaging

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// Mutation: omit native SessionID from discovery; fork transcript joins must fail.
func TestCodexNativeDiscoveryPreservesThreadAndTranscriptIdentity(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	fake := &fakeCodex{state: "idle"}
	env.Set("SHUTTLE_CODEX_SOCKET", startFakeCodex(t, fake))
	ss, err := (codexAdapter{}).discover(context.Background(), env, "host")
	if err != nil || len(ss) != 1 {
		t.Fatalf("discovery: %#v %v", ss, err)
	}
	s := ss[0]
	if s.ID != "thread-1" || s.TranscriptID != "transcript-1" || s.Address != "shuttle://host/codex/thread-1" || !slices.Contains(s.Capabilities, "wake") {
		t.Fatalf("native identity and capabilities: %#v", s)
	}
}

func TestCodexExplicitRemoteHookStillAcceptsNativeInput(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	fake := &fakeCodex{state: "idle", mutation: "turn/start", mutationReply: map[string]any{"turn": map[string]any{"id": "turn-1", "status": "inProgress"}}}
	socket := startFakeCodex(t, fake)
	env.Set("SHUTTLE_CODEX_SOCKET", socket)
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "ps"), []byte("#!/bin/sh\nprintf '%s\\n' 'codex --remote unix://"+socket+" resume thread-1'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	env.Set("PATH", bin+string(os.PathListSeparator)+env.Getenv("PATH"))
	if err := RegisterMailbox(env, "codex", "thread-1", "host", "/work", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	receipt, err := Send(context.Background(), env, "host", Request{Address: "shuttle://host/codex/thread-1", Text: "wake", MessageID: "remote-hook", Wake: true})
	if err != nil || receipt.Status != StatusAccepted || fake.methodCount("turn/start") != 1 {
		t.Fatalf("explicit remote hook: %#v %v", receipt, err)
	}
}

func TestCodexHookOnlyContextAndHonestWakeRejection(t *testing.T) {
	t.Parallel()
	for _, runtime := range []string{"absent", "notLoaded", "idle", "active"} {
		t.Run(runtime, func(t *testing.T) {
			env := testEnv(t)
			var fake *fakeCodex
			if runtime == "absent" {
				env.Set("SHUTTLE_CODEX_SOCKET", filepath.Join(t.TempDir(), "absent.sock"))
			} else {
				fake = &fakeCodex{state: "notLoaded"}
				env.Set("SHUTTLE_CODEX_SOCKET", startFakeCodex(t, fake))
			}
			if err := RegisterMailbox(env, "codex", "thread-1", "host", "/work", os.Getpid(), true); err != nil {
				t.Fatal(err)
			}
			req := Request{Address: "shuttle://host/codex/thread-1", Text: "context", MessageID: "hook-context"}
			receipt, err := Send(context.Background(), env, "host", req)
			if err != nil || receipt.Transport != "codex-hook" || receipt.Status != StatusQueued {
				t.Fatalf("context-only: %#v %v", receipt, err)
			}
			req.Wake, req.MessageID = true, "hook-wake"
			receipt, err = Send(context.Background(), env, "host", req)
			if err == nil || receipt.Status != StatusRejected || receipt.Transport != "codex-app-server" || !strings.Contains(receipt.Detail, "--remote unix://PATH") || !strings.Contains(receipt.Detail, "--context-only") {
				t.Fatalf("wake rejection: %#v %v", receipt, err)
			}
			if fake != nil && fake.methodCount("thread/read") != 0 {
				t.Fatal("looked up a native shadow instead of honoring the hook receiver")
			}
			if fake != nil && (fake.methodCount("turn/start") != 0 || fake.methodCount("turn/steer") != 0 || fake.methodCount("thread/resume") != 0) {
				t.Fatal("attempted to control a conversation owned by another runtime")
			}
		})
	}
}
