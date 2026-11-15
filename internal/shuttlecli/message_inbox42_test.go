package shuttlecli

import (
	"net/http"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/messaging"
)

// versionStub answers this host's /version as hub at hubLevel and the
// owner's (origin worker-node) at 42.
func versionStub(hubLevel string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("origin") == "worker-node" {
			w.Write([]byte(`{"host":"worker-node","contract_level":42}`))
			return
		}
		w.Write([]byte(`{"host":"hub","contract_level":` + hubLevel + `}`))
	}
}

func TestLiveFiberMessage42NeverPostsSessionMessages(t *testing.T) {
	env := testEnv(t)
	store := writeMessageTargetFiber(t, map[string]any{"kind": "oneshot", "host": "worker-node", "agent": "claude-opus", "project_dir": t.TempDir()})
	isolateMessageFiberStore(env, store)
	deliver, requests := dormantDeliverStub(202, `{"queued":true,"status":"woken","consumed":{"action":"wake"}}`)
	daemonStub(t, env, map[string]http.HandlerFunc{
		"/api/v1/version":  versionStub("42"),
		"/api/v1/deliver":  deliver,
		"/api/v1/messages": func(w http.ResponseWriter, r *http.Request) { t.Error("posted session message"); w.WriteHeader(500) },
	})
	out, _, err := runMessage(t, newApp(env), "work/worker", "publication")
	if err != nil {
		t.Fatal(err)
	}
	if got := requests(); len(got) != 1 || got[0]["unless_live"] != false {
		t.Fatalf("%+v", got)
	}
	if !strings.Contains(out, "woken") {
		t.Fatal(out)
	}
}

// --fresh is one launch request on every owner: an older one starts the
// session as before, a 42 one records the id and starts it under the gate.
// It never asks for the owner's level.
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

// The CLI promises an idle subscription on a queued fiber message only when
// the owner makes one, which an owner below 42 does not.
func TestQueuedIdleSubscriptionLineFollowsTheOwnerLevel(t *testing.T) {
	for _, level := range []string{"41", "42"} {
		env := testEnv(t)
		store := writeMessageTargetFiber(t, map[string]any{"kind": "oneshot", "host": "hub", "agent": "claude-opus", "project_dir": t.TempDir()})
		isolateMessageFiberStore(env, store)
		deliver, _ := dormantDeliverStub(202, `{"queued":true,"status":"starting"}`)
		daemonStub(t, env, map[string]http.HandlerFunc{
			"/api/v1/version": versionStub(level),
			"/api/v1/deliver": deliver,
		})
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
		recorded := strings.Contains(stderr.String(), "idle subscription: recorded")
		if recorded != (level == "42") || (level == "41" && !strings.Contains(stderr.String(), "idle subscription: unsupported")) {
			t.Fatalf("level %s: %q", level, stderr.String())
		}
	}
}
