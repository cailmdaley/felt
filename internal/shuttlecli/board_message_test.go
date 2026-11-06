package shuttlecli

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/cailmdaley/felt/internal/messaging"
)

func TestBoardMessageReceiptControlsRecording(t *testing.T) {
	for _, status := range []string{messaging.StatusAccepted, messaging.StatusQueued, messaging.StatusContextAdded, messaging.StatusRejected, messaging.StatusSubmitted} {
		t.Run(string(status), func(t *testing.T) {
			env, sink, _ := sendFileTestEnv(t)
			daemonStub(t, env, map[string]http.HandlerFunc{"/api/v1/messages": func(w http.ResponseWriter, r *http.Request) {
				var req messaging.Request
				_ = json.NewDecoder(r.Body).Decode(&req)
				_ = json.NewEncoder(w).Encode(messaging.Receipt{MessageID: req.MessageID, Address: req.Address, Status: status, Transport: "claude-native"})
			}})
			a := newApp(env)
			var opts messageOptions
			cmd := a.messageCmd(&opts)
			opts.id, opts.from = "m", "sender"
			if status == messaging.StatusContextAdded {
				opts.contextOnly = true
			}
			_ = cmd.RunE(cmd, []string{"shuttle://remote/pi/session", "hello"})
			data, err := os.ReadFile(sink)
			wanted := status != messaging.StatusRejected
			if !wanted {
				if !os.IsNotExist(err) {
					t.Fatalf("unexpected record: %s %v", data, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var record boardRecord
			if json.Unmarshal(data, &record) != nil || record.To == nil || record.To.Session != "shuttle://remote/pi/session" || record.Kind != "message" {
				t.Fatalf("%s", data)
			}
		})
	}
}

func TestLocalMessageDoesNotRecordBoardMessage(t *testing.T) {
	env, sink, _ := sendFileTestEnv(t)
	env.Set("SHUTTLE_DATA_DIR", t.TempDir())
	if err := messaging.RegisterMailbox(env, "pi", "target", "test-host", "/tmp", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	a := newApp(env)
	var opts messageOptions
	cmd := a.messageCmd(&opts)
	cmd.SetContext(context.Background())
	opts.local = true
	opts.id = "m"
	opts.from = "sender"
	opts.wake = false
	if err := cmd.RunE(cmd, []string{"shuttle://test-host/pi/target", "hello"}); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(sink); !os.IsNotExist(err) {
		t.Fatalf("local message recorded: %s %v", b, err)
	}
}

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
