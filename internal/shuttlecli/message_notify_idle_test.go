package shuttlecli

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// runNotifyOnly sends `shuttle message work/worker --notify-when-idle` with no
// text to an owner that answers status and body, and returns stdout, the
// error and the one /deliver request.
func runNotifyOnly(t *testing.T, status int, body string) (string, error, map[string]any) {
	t.Helper()
	env := testEnv(t)
	store := writeMessageTargetFiber(t, map[string]any{
		"kind": "oneshot", "host": "worker-node", "agent": "claude-opus", "project_dir": t.TempDir(),
	})
	isolateMessageFiberStore(env, store)
	deliver, requests := dormantDeliverStub(status, body)
	daemonStub(t, env, map[string]http.HandlerFunc{
		"/api/v1/deliver":  deliver,
		"/api/v1/messages": func(w http.ResponseWriter, r *http.Request) { t.Error("posted a session message"); w.WriteHeader(500) },
	})
	app := newApp(env)
	var stdout bytes.Buffer
	app.env.Stdout = &stdout
	app.env.Stderr = io.Discard
	var opts messageOptions
	cmd := app.messageCmd(&opts)
	opts.id, opts.from, opts.notifyIdle, opts.notifyWake = "n-1", "shuttle://here/claude/subscriber", true, true
	cmd.SetIn(strings.NewReader(""))
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)
	err := cmd.RunE(cmd, []string{"work/worker"})
	got := requests()
	if len(got) != 1 {
		t.Fatalf("deliver requests = %d, want 1", len(got))
	}
	return stdout.String(), err, got[0]
}

// A notify-only send asks the fiber's owner for the subscription, with no
// text, and prints the receipt the owner answers for its live worker.
func TestNotifyOnlyFiberSubscription(t *testing.T) {
	t.Parallel()
	stdout, err, request := runNotifyOnly(t, http.StatusOK,
		`{"message_id":"n-1","address":"shuttle://worker-node/claude/w1","status":"subscribed","transport":"claude-native"}`)
	if err != nil {
		t.Fatal(err)
	}
	if stdout != "subscribed shuttle://worker-node/claude/w1 (n-1)\n" {
		t.Fatalf("stdout = %q", stdout)
	}
	want := map[string]any{
		"fiber_id": messageTargetFiberUID, "origin": "worker-node", "from": "shuttle://here/claude/subscriber",
		"message_id": "n-1", "notify_when_idle": true, "notify_wake": true,
	}
	for key, value := range want {
		if request[key] != value {
			t.Errorf("deliver %s = %v, want %v", key, request[key], value)
		}
	}
	if _, ok := request["text"]; ok {
		t.Errorf("notify-only request carries text: %v", request["text"])
	}
}

// An owner that does not answer the local daemon in time leaves the
// subscription's outcome unknown: the CLI says so, with the retry guidance.
func TestNotifyOnlyFiberSubscriptionForwardTimeout(t *testing.T) {
	t.Parallel()
	stdout, err, _ := runNotifyOnly(t, http.StatusAccepted,
		`{"delivered":null,"reason":"forward_timeout","origin":"worker-node","detail":"worker-node did not answer in time; the message may have reached its worker"}`)
	if stdout != "unknown work/worker (n-1)\n" {
		t.Fatalf("stdout = %q", stdout)
	}
	if err == nil || !strings.Contains(err.Error(), "worker-node did not answer in time") ||
		!strings.Contains(err.Error(), "Retry this exact request with the same message_id") {
		t.Fatalf("err = %v", err)
	}
}

// A definite refusal prints no receipt: a fiber with no live worker (409) and
// an owner on a build that takes no notify-only request (400) fail with the
// owner's reason and nothing on stdout.
func TestNotifyOnlyFiberRefusalPrintsNoReceipt(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		status int
		body   string
	}{
		{http.StatusConflict, `{"error":"work/worker has no live worker to watch"}`},
		{http.StatusBadRequest, `{"delivered":false,"error":"text is required"}`},
	} {
		stdout, err, _ := runNotifyOnly(t, tc.status, tc.body)
		if stdout != "" {
			t.Errorf("%d: stdout = %q, want nothing", tc.status, stdout)
		}
		var refusal struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal([]byte(tc.body), &refusal)
		if err == nil || !strings.Contains(err.Error(), refusal.Error) || !strings.Contains(err.Error(), "message n-1") {
			t.Errorf("%d: err = %v", tc.status, err)
		}
	}
}
