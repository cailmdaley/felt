package messaging

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Claude Code from 2.1.325 admits a native peer message as a user row with its own
// uuid and the native id under origin.msg_id (shape copied from the live
// transcript of 15 Nov 18:27 UTC).
func TestObserveClaudeTurnMatchesOriginMsgIDOnUserRow(t *testing.T) {
	const native = "7d8b919d-c7ae-53cd-8c04-31b0f6558719"
	const content = "[from x]\nhello"
	rows := []map[string]any{
		{"type": "queue-operation", "operation": "enqueue", "sessionId": "session", "content": content},
		{"type": "queue-operation", "operation": "dequeue", "sessionId": "session"},
		{"type": "user", "sessionId": "session", "uuid": "0c7d22da-fresh", "parentUuid": "prev", "isMeta": true,
			"origin": map[string]any{"kind": "peer", "msg_id": native}, "message": map[string]any{"role": "user", "content": "Another Claude session sent a message: ..."}},
		{"type": "assistant", "sessionId": "session", "uuid": "reply", "parentUuid": "0c7d22da-fresh", "message": map[string]any{"role": "assistant", "model": "claude-opus-5-5"}},
	}
	path := filepath.Join(t.TempDir(), "t.jsonl")
	f, _ := os.Create(path)
	for _, r := range rows {
		_ = json.NewEncoder(f).Encode(r)
	}
	f.Close()
	f, _ = os.Open(path)
	defer f.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	stage, err := observeClaudeTurn(ctx, f, path, "session", native, nativeContentHash(content), nil)
	t.Logf("stage=%q err=%v", stage, err)
	if stage != StatusAccepted {
		t.Fatalf("a delivered and answered 2.1.325 peer turn observes as %q, not accepted", stage)
	}
}

// What an open batch whose native receipt stays `queued` does to a live
// worker, a fiber whose worker ended, and the replacement it launches. The
// sender stands in for withDedup: the pinned transport id replays its stored

func TestObserveClaudeTurnMatchesOriginMsgIDOnQueuedCommand(t *testing.T) {
	const native = "57379fbd-a537-5ccb-8c8f-b6128f01ccc4"
	rows := []map[string]any{
		{"type": "attachment", "sessionId": "session", "uuid": "absorbed", "parentUuid": "tool-result",
			"attachment": map[string]any{"type": "queued_command", "source_uuid": "e1889751-fresh", "origin": map[string]any{"kind": "peer", "msg_id": native}}},
		{"type": "assistant", "sessionId": "session", "uuid": "reply", "parentUuid": "absorbed", "message": map[string]any{"role": "assistant", "model": "claude-opus-5-5"}},
	}
	path := filepath.Join(t.TempDir(), "t.jsonl")
	f, _ := os.Create(path)
	for _, r := range rows {
		_ = json.NewEncoder(f).Encode(r)
	}
	f.Close()
	f, _ = os.Open(path)
	defer f.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if stage, err := observeClaudeTurn(ctx, f, path, "session", native, "", nil); stage != StatusAccepted {
		t.Fatalf("absorbed 2.1.325 peer message observes as %q (%v)", stage, err)
	}
}

// The same consequences through the real sender (sendFiberContextAttempt →
