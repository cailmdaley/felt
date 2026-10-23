package messaging

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
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
	for _, launch := range []string{"--remote ", "--remote=", "app-server --listen ", "app-server --listen="} {
		t.Run(launch, func(t *testing.T) {
			env := testEnv(t)
			fake := &fakeCodex{state: "idle", mutation: "turn/start", mutationReply: map[string]any{"turn": map[string]any{"id": "turn-1", "status": "inProgress"}}}
			original := startFakeCodex(t, fake)
			socket := filepath.Join(filepath.Dir(original), "control with spaces.sock")
			if err := os.Rename(original, socket); err != nil {
				t.Fatal(err)
			}
			env.Set("SHUTTLE_CODEX_SOCKET", socket)
			bin := t.TempDir()
			command := "codex " + launch + "unix://" + socket
			if strings.HasPrefix(launch, "--remote") {
				command += " resume thread-1"
			}
			if err := os.WriteFile(filepath.Join(bin, "ps"), []byte("#!/bin/sh\nprintf '%s\\n' '"+command+"'\n"), 0700); err != nil {
				t.Fatal(err)
			}
			env.Set("PATH", bin+string(os.PathListSeparator)+env.Getenv("PATH"))
			receiver := startReceiver(t)
			if err := RegisterMailbox(env, "codex", "thread-1", "host", "/work", receiver.Process.Pid, true); err != nil {
				t.Fatal(err)
			}
			receipt, err := Send(context.Background(), env, "host", Request{Address: "shuttle://host/codex/thread-1", Text: "wake", MessageID: "remote-hook", Wake: true})
			if err != nil || receipt.Status != StatusAccepted || fake.methodCount("turn/start") != 1 {
				t.Fatalf("explicit endpoint with spaces: %#v %v", receipt, err)
			}
		})
	}
}

func TestCodexHookReceiverMatchingUnixPeerDoesNotDependOnArgv(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	fake := &fakeCodex{state: "idle", mutation: "turn/start", mutationReply: map[string]any{"turn": map[string]any{"id": "turn-1", "status": "inProgress"}}}
	original := startFakeCodex(t, fake)
	socket := filepath.Join(filepath.Dir(original), "peer with spaces.sock")
	if err := os.Rename(original, socket); err != nil {
		t.Fatal(err)
	}
	env.Set("SHUTTLE_CODEX_SOCKET", socket)
	env.Set("PATH", t.TempDir()) // No ps executable: only the real peer can establish ownership.
	if err := RegisterMailbox(env, "codex", "thread-1", "host", "/work", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	receipt, err := Send(context.Background(), env, "host", Request{Address: "shuttle://host/codex/thread-1", Text: "wake", MessageID: "peer-hook", Wake: true})
	if err != nil || receipt.Status != StatusAccepted || fake.methodCount("turn/start") != 1 {
		t.Fatalf("matching Unix peer: %#v %v", receipt, err)
	}
}

func TestCodexHookPeerProbeValidatesEndpointBeforeConnecting(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	root, err := os.MkdirTemp("/tmp", "cx-peer-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	socket := filepath.Join(root, "control.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	// This resolves to the live test listener but is not a clean endpoint.
	env.Set("SHUTTLE_CODEX_SOCKET", filepath.Dir(socket)+"/./"+filepath.Base(socket))
	if err := RegisterMailbox(env, "codex", "thread-1", "host", "/work", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	if !codexHookOwnsInput(context.Background(), env, Address{Host: "host", ID: "thread-1"}) {
		t.Fatal("invalid endpoint reached a matching Unix peer")
	}
	if _, err := dialCodex(context.Background(), env); err == nil {
		t.Fatal("RPC accepted the invalid endpoint")
	}
	listener.(*net.UnixListener).SetDeadline(time.Now().Add(20 * time.Millisecond))
	if conn, err := listener.Accept(); err == nil {
		conn.Close()
		t.Fatal("invalid endpoint received a connection")
	} else if timeout, ok := err.(net.Error); !ok || !timeout.Timeout() {
		t.Fatalf("listener observation failed: %v", err)
	}
}

func TestCodexHookEndpointClassificationIgnoresPromptAndConfigText(t *testing.T) {
	t.Parallel()
	endpoint := "unix:///tmp/private/control with spaces.sock"
	for _, command := range []string{
		"codex resume thread-1 --remote " + endpoint,
		"codex -c developer_instructions=use --remote " + endpoint,
		"bash -c codex --remote " + endpoint,
		"codex --remote " + endpoint + "-different resume thread-1",
		"codex app-server --listen " + endpoint + "-different",
	} {
		if codexExplicitEndpoint(command, endpoint) {
			t.Errorf("accepted non-owner launch: %s", command)
		}
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
				fake = &fakeCodex{state: runtime}
				env.Set("SHUTTLE_CODEX_SOCKET", startFakeCodex(t, fake))
			}
			receiver := startReceiver(t)
			if err := RegisterMailbox(env, "codex", "thread-1", "host", "/work", receiver.Process.Pid, true); err != nil {
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
