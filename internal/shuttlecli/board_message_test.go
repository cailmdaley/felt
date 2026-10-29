package shuttlecli

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestBoardMessageQueuedForWorker(t *testing.T) {
	env := testEnv(t)
	store := writeMessageTargetFiber(t, map[string]any{"kind": "oneshot", "host": "worker-node", "agent": "claude-opus", "project_dir": t.TempDir()})
	isolateMessageFiberStore(env, store)
	sink := filepath.Join(t.TempDir(), "events.jsonl")
	env.Set("SHUTTLE_EVENTS_FILE", sink)
	env.Set("SHUTTLE_EVENTS", "")
	env.Set("SHUTTLE_HOST", "test-host")
	deliver, _ := dormantDeliverStub(http.StatusAccepted, `{"queued":true}`)
	daemonStub(t, env, map[string]http.HandlerFunc{"/api/v1/deliver": deliver})
	if _, _, err := runMessage(t, newApp(env), "work/worker", "hello"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(sink)
	if err != nil {
		t.Fatal(err)
	}
	var r boardRecord
	if err := json.Unmarshal(data, &r); err != nil {
		t.Fatal(err)
	}
	if r.Kind != "message" || r.Fiber != messageTargetFiberUID || r.To == nil || r.To.Fiber != messageTargetFiberUID || r.By == nil || r.By.Label != "test sender" || r.Text != "hello" || !r.Wake {
		t.Fatalf("record: %+v", r)
	}
}
