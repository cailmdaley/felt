package shuttlecli

import (
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/messaging"
)

func TestResolveMessageTargetCodexCLIHookSession(t *testing.T) {
	for _, tc := range []struct {
		name, surface, state, harness, peerID, fiberUID string
		want                                            bool
	}{
		{"cli", "cli", "hook", "codex", messageTargetSession, messageTargetFiberUID, true},
		{"default_cli", "", "hook", "codex", messageTargetSession, messageTargetFiberUID, true},
		{"app_unmapped", "app", "hook", "codex", messageTargetSession, messageTargetFiberUID, false},
		{"wrong_session", "cli", "hook", "codex", "other-session", messageTargetFiberUID, false},
		{"wrong_harness", "cli", "hook", "pi", messageTargetSession, messageTargetFiberUID, false},
		{"wrong_fiber", "cli", "hook", "codex", messageTargetSession, "other-uid", false},
		{"not_hook", "cli", "idle", "codex", messageTargetSession, messageTargetFiberUID, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := testEnv(t)
			block := map[string]any{"kind": "oneshot", "host": "worker-node", "agent": "codex-luna", "project_dir": t.TempDir(), "runtime": map[string]any{"session_uuid": "stale-session"}}
			if tc.surface != "" {
				block["surface"] = tc.surface
			}
			store := writeMessageTargetFiber(t, block)
			isolateMessageFiberStore(env, store)
			address := "shuttle://worker-node/" + tc.harness + "/" + tc.peerID
			messageTargetDaemon(t, env, []messaging.Session{{Address: address, Host: "worker-node", Harness: tc.harness, ID: tc.peerID, Fiber: "work/worker", FiberUID: tc.fiberUID, State: tc.state, Capabilities: []string{"context", "wake"}}}, []SessionProvenance{{Fiber: "work/worker", UID: messageTargetFiberUID, Session: messageTargetSession, Host: "worker-node", Harness: "codex", At: 2, Kind: "dispatch"}})
			got, err := newApp(env).resolveMessageTarget("work/worker")
			if tc.want {
				if err != nil || got != address {
					t.Fatalf("resolve fiber: %q %v", got, err)
				}
				for _, target := range []string{messageTargetSession, address} {
					got, err := newApp(env).resolveMessageTarget(target)
					if err != nil || got != address {
						t.Fatalf("resolve %s: %q %v", target, got, err)
					}
				}
			} else if err == nil || !strings.Contains(err.Error(), "thread id") {
				t.Fatalf("expected unmapped refusal, got %q %v", got, err)
			}
		})
	}
}
