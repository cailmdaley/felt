package shuttlecli

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/cailmdaley/felt/internal/messaging"
)

func TestQuietLiveFiberKeepsIdleSubscriptionRoute(t *testing.T) {
	env := testEnv(t)
	store := writeMessageTargetFiber(t, map[string]any{"kind": "oneshot", "host": "worker-node", "agent": "claude-opus", "project_dir": t.TempDir(), "runtime": map[string]any{"session_uuid": messageTargetSession}})
	isolateMessageFiberStore(env, store)
	daemonStub(t, env, map[string]http.HandlerFunc{"/api/v1/deliver": func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		if payload["unless_live"] != true || payload["notify_when_idle"] != true {
			t.Errorf("idle subscription bypassed live path: %v", payload)
		}
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"live":true}`))
	}})
	receipt, err := newApp(env).queueForNextWorker(messaging.Request{Address: "work/worker", MessageID: "idle", Text: "quiet context", NotifyWhenIdle: true})
	if err != nil || receipt != nil {
		t.Fatalf("live idle subscription must use session send: %+v, %v", receipt, err)
	}
}
