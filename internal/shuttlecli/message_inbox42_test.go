package shuttlecli

import (
	"github.com/cailmdaley/felt/internal/messaging"
	"net/http"
	"strings"
	"testing"
)

func TestLiveFiberMessage42NeverPostsSessionMessages(t *testing.T) {
	for _, fresh := range []bool{false, true} {
		env := testEnv(t)
		store := writeMessageTargetFiber(t, map[string]any{"kind": "oneshot", "host": "worker-node", "agent": "claude-opus", "project_dir": t.TempDir()})
		isolateMessageFiberStore(env, store)
		deliver, requests := dormantDeliverStub(202, `{"queued":true,"status":"woken","consumed":{"action":"wake"}}`)
		daemonStub(t, env, map[string]http.HandlerFunc{
			"/api/v1/version": func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Query().Get("origin") != "worker-node" {
					t.Error("not checking owner")
				}
				w.Write([]byte(`{"host":"worker-node","contract_level":42}`))
			},
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
