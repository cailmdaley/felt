package shuttlecli

import (
	"net/http"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/messaging"
)

// A waking message to a live fiber goes to its inbox through the owner, never
// to its worker as a session message.
func TestLiveFiberMessageNeverPostsSessionMessages(t *testing.T) {
	env := testEnv(t)
	store := writeMessageTargetFiber(t, map[string]any{"kind": "oneshot", "host": "worker-node", "agent": "claude-opus", "project_dir": t.TempDir()})
	isolateMessageFiberStore(env, store)
	deliver, requests := dormantDeliverStub(202, `{"queued":true,"status":"woken","consumed":{"action":"wake"}}`)
	daemonStub(t, env, map[string]http.HandlerFunc{
		"/api/v1/deliver":  deliver,
		"/api/v1/messages": func(w http.ResponseWriter, r *http.Request) { t.Error("posted session message"); w.WriteHeader(500) },
	})
	out, _, err := runMessage(t, newApp(env), "work/worker", "publication")
	if err != nil {
		t.Fatal(err)
	}
	if got := requests(); len(got) != 1 || got[0]["context_only"] != true || got[0]["turn"] != "ask" {
		t.Fatalf("%+v", got)
	}
	if !strings.Contains(out, "woken") {
		t.Fatal(out)
	}
}

// --fresh is one launch request, which the owner records under its id and
// starts under the gate. It never asks for the owner's level.
func TestFreshIsOneLaunchRequestOnEveryOwner(t *testing.T) {
	env := testEnv(t)
	store := writeMessageTargetFiber(t, map[string]any{"kind": "oneshot", "host": "worker-node", "agent": "claude-opus", "project_dir": t.TempDir()})
	isolateMessageFiberStore(env, store)
	deliver, requests := dormantDeliverStub(200, `{"delivered":true,"delivery":"fresh"}`)
	daemonStub(t, env, map[string]http.HandlerFunc{
		"/api/v1/version": func(w http.ResponseWriter, r *http.Request) {
			t.Error("asked for the owner's level")
			w.WriteHeader(500)
		},
		"/api/v1/deliver": deliver,
	})
	if err := newApp(env).messageFresh(messaging.Request{Address: "work/worker", Text: "publication", MessageID: "fresh1", From: "fixture"}); err != nil {
		t.Fatal(err)
	}
	got := requests()
	if len(got) != 1 || got[0]["resume_mode"] != "fresh" || got[0]["message_id"] != "fresh1" || got[0]["context_only"] != nil {
		t.Fatalf("%+v", got)
	}
}

// A refused fresh request fails with the owner's reason.
func TestFreshRefusedNamesTheReason(t *testing.T) {
	env := testEnv(t)
	store := writeMessageTargetFiber(t, map[string]any{"kind": "oneshot", "host": "worker-node", "agent": "claude-opus", "project_dir": t.TempDir()})
	isolateMessageFiberStore(env, store)
	deliver, _ := dormantDeliverStub(409, `{"delivered":false,"delivery":"fresh","reason":"held","error":"no fresh session started: worker-node holds new sessions until its boot quarantine is released"}`)
	daemonStub(t, env, map[string]http.HandlerFunc{"/api/v1/deliver": deliver})
	err := newApp(env).messageFresh(messaging.Request{Address: "work/worker", Text: "publication", MessageID: "fresh2", From: "fixture"})
	if err == nil || !strings.Contains(err.Error(), "boot quarantine") {
		t.Fatalf("%v", err)
	}
}

// A queued fiber message with --notify-when-idle says the owner subscribes
// when the worker takes the entry.
func TestQueuedIdleSubscriptionLine(t *testing.T) {
	env := testEnv(t)
	store := writeMessageTargetFiber(t, map[string]any{"kind": "oneshot", "host": "hub", "agent": "claude-opus", "project_dir": t.TempDir()})
	isolateMessageFiberStore(env, store)
	deliver, requests := dormantDeliverStub(202, `{"queued":true,"status":"starting"}`)
	daemonStub(t, env, map[string]http.HandlerFunc{"/api/v1/deliver": deliver})
	app := newApp(env)
	var stderr strings.Builder
	app.env.Stderr = &stderr
	var opts messageOptions
	cmd := app.messageCmd(&opts)
	opts.id, opts.from = "msg-idle", "test sender"
	cmd.SetIn(strings.NewReader(""))
	if err := cmd.ParseFlags([]string{"--notify-when-idle"}); err != nil {
		t.Fatal(err)
	}
	if err := cmd.RunE(cmd, []string{"work/worker", "publication"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stderr.String(), "idle subscription: recorded") {
		t.Fatalf("%q", stderr.String())
	}
	if got := requests(); len(got) != 1 || got[0]["notify_when_idle"] != true {
		t.Fatalf("%+v", got)
	}
}
