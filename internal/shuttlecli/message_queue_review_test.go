package shuttlecli

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/cailmdaley/felt/internal/messaging"
)

func TestQuietLiveFiberIdleSubscriptionGoesToTheInbox(t *testing.T) {
	env := testEnv(t)
	store := writeMessageTargetFiber(t, map[string]any{"kind": "oneshot", "host": "worker-node", "agent": "claude-opus", "project_dir": t.TempDir(), "runtime": map[string]any{"session_uuid": messageTargetSession}})
	isolateMessageFiberStore(env, store)
	daemonStub(t, env, map[string]http.HandlerFunc{"/api/v1/deliver": func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		if payload["notify_when_idle"] != true || payload["context_only"] != true {
			t.Errorf("idle subscription left the inbox: %v", payload)
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"queued":true,"status":"delivered"}`))
	}})
	receipt, err := newApp(env).queueForFiber(messaging.Request{Address: "work/worker", MessageID: "idle", Text: "quiet context", NotifyWhenIdle: true}, false)
	if err != nil || receipt == nil || receipt.Status != "delivered" {
		t.Fatalf("live idle subscription must go to the inbox: %+v, %v", receipt, err)
	}
}
