package shuttlecli

import (
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/messaging"
)

// A Codex CLI worker's hook peer makes its ledger session addressable
// without a separate thread id.
func TestFiberWorkerAddressCodexCLIHookSession(t *testing.T) {
	for _, tc := range []struct {
		name, surface, state, harness, peerID, fiberUID string
		want                                            bool
	}{
		{"cli", "cli", "hook", "codex", messageTargetSession, messageTargetFiberUID, true},
		{"default_cli", "", "hook", "codex", messageTargetSession, messageTargetFiberUID, true},
		{"legacy_app_ignored", "app", "hook", "codex", messageTargetSession, messageTargetFiberUID, true},
		{"wrong_session", "cli", "hook", "codex", "other-session", messageTargetFiberUID, false},
		{"wrong_harness", "cli", "hook", "pi", messageTargetSession, messageTargetFiberUID, false},
		{"wrong_fiber", "cli", "hook", "codex", messageTargetSession, "other-uid", false},
		{"not_hook", "cli", "idle", "codex", messageTargetSession, messageTargetFiberUID, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			block := map[string]any{"kind": "oneshot", "host": "worker-node", "agent": "codex-luna", "runtime": map[string]any{"session_uuid": "stale-session"}}
			if tc.surface != "" {
				block["surface"] = tc.surface
			}
			f := &felt.Felt{ID: "work/worker", UID: messageTargetFiberUID}
			if err := f.SetExtraField("shuttle", block); err != nil {
				t.Fatal(err)
			}
			address := "shuttle://worker-node/" + tc.harness + "/" + tc.peerID
			peers := []messaging.Session{{Address: address, Host: "worker-node", Harness: tc.harness, ID: tc.peerID, Fiber: "work/worker", FiberUID: tc.fiberUID, State: tc.state, Capabilities: []string{"context", "wake"}}}
			worker := &SessionProvenance{Fiber: "work/worker", UID: messageTargetFiberUID, Session: messageTargetSession, Host: "worker-node", Harness: "codex", At: 2, Kind: "dispatch"}
			got, err := fiberWorkerAddress(f, worker, "codex", "stale-session", peers)
			if tc.want {
				if err != nil || got != address {
					t.Fatalf("worker address: %q %v", got, err)
				}
			} else if err == nil || !strings.Contains(err.Error(), "thread id") {
				t.Fatalf("expected unmapped refusal, got %q %v", got, err)
			}
		})
	}
}
