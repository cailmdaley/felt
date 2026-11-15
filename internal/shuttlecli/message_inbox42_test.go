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
	for _, fresh := range []bool{false, true} {
		env := testEnv(t)
		store := writeMessageTargetFiber(t, map[string]any{"kind": "oneshot", "host": "worker-node", "agent": "claude-opus", "project_dir": t.TempDir()})
		isolateMessageFiberStore(env, store)
		deliver, requests := dormantDeliverStub(202, `{"queued":true,"status":"woken","consumed":{"action":"wake"}}`)
		daemonStub(t, env, map[string]http.HandlerFunc{
			"/api/v1/version":  versionStub("42"),
			"/api/v1/deliver":  deliver,
			"/api/v1/messages": func(w http.ResponseWriter, r *http.Request) { t.Error("posted session message"); w.WriteHeader(500) },
		})
		app := newApp(env)
		var out string
		var err error
		if fresh {
			err = app.messageFresh(messaging.Request{Address: "work/worker", Text: "publication", MessageID: "fresh42", From: "fixture"})
		} else {
			out, _, err = runMessage(t, app, "work/worker", "publication")
		}
		if err != nil {
			t.Fatal(err)
		}
		got := requests()
		if len(got) != 1 || got[0]["unless_live"] != false {
			t.Fatalf("%+v", got)
		}
		if fresh {
			if got[0]["session"] != "fresh" || got[0]["turn"] != "force" {
				t.Fatalf("%+v", got)
			}
		} else if !strings.Contains(out, "woken") {
			t.Fatal(out)
		}
	}
}

// A 41 hub forwards only the fields it knows, so a 42 owner behind it gets
// the old wire: a --fresh keeps its launch envelope rather than a session
// field the hub would drop.
func TestFreshBehindAnOlderHubKeepsTheLaunchEnvelope(t *testing.T) {
	env := testEnv(t)
	store := writeMessageTargetFiber(t, map[string]any{"kind": "oneshot", "host": "worker-node", "agent": "claude-opus", "project_dir": t.TempDir()})
	isolateMessageFiberStore(env, store)
	deliver, requests := dormantDeliverStub(200, `{"delivered":true,"delivery":"dispatch"}`)
	daemonStub(t, env, map[string]http.HandlerFunc{
		"/api/v1/version": versionStub("41"),
		"/api/v1/deliver": deliver,
	})
	if err := newApp(env).messageFresh(messaging.Request{Address: "work/worker", Text: "publication", MessageID: "fresh41", From: "fixture"}); err != nil {
		t.Fatal(err)
	}
	got := requests()
	if len(got) != 1 || got[0]["resume_mode"] != "fresh" || got[0]["session"] != nil || got[0]["context_only"] != nil {
		t.Fatalf("%+v", got)
	}
}
