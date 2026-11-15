package shuttlecli

import (
	"encoding/json"
	"github.com/cailmdaley/felt/internal/messaging"
	"net/http"
	"testing"
)

func TestInboxScheduledRawKeyAndCancel(t *testing.T) {
	env := testEnv(t)
	a := newApp(env)
	for _, e := range []messaging.InboxEntry{
		{Address: "store:raw", Request: messaging.Request{MessageID: "later", Text: "check the fit\nmore"}, Wishes: messaging.Wishes{NotBefore: "2999-01-01T00:00:00Z"}},
		{Address: "store:raw", Request: messaging.Request{MessageID: "quiet", Text: "quiet"}},
	} {
		if err := messaging.Enqueue(env, e); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := a.listInbox("store:raw", true)
	if err != nil || len(entries) != 1 || entries[0].Text != "check the fit" {
		t.Fatalf("%+v %v", entries, err)
	}
	cmd := a.shuttleInboxCmd()
	cmd.SetArgs([]string{"cancel", "store:raw", "later"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	entries, err = a.listInbox("store:raw", true)
	if err != nil || len(entries) != 0 {
		t.Fatalf("%+v %v", entries, err)
	}
}

func TestInboxFiberReferencesUseOwnerRoute(t *testing.T) {
	env := testEnv(t)
	store := writeMessageTargetFiber(t, map[string]any{"kind": "oneshot", "host": "worker-node", "agent": "claude-opus", "project_dir": t.TempDir()})
	isolateMessageFiberStore(env, store)
	var calls []map[string]string
	daemonStub(t, env, map[string]http.HandlerFunc{"/api/v1/inbox": func(w http.ResponseWriter, r *http.Request) {
		var p map[string]string
		json.NewDecoder(r.Body).Decode(&p)
		calls = append(calls, p)
		w.Write([]byte(`{"entries":[{"id":"later","not_before":"2999-01-01T00:00:00Z","text":"Check the fit","from":"fit"}]}`))
	}})
	a := newApp(env)
	for _, ref := range []string{"work/worker", "worker", "01ARZ3NDEKTSV4RRFFQ69G5FAV"} {
		entries, err := a.listInbox(ref, true)
		if err != nil || len(entries) != 1 || entries[0].Text != "Check the fit" {
			t.Fatalf("%s %+v %v", ref, entries, err)
		}
	}
	if _, err := a.ownerInbox("worker", "cancel", "later"); err != nil {
		t.Fatal(err)
	}
	for _, p := range calls {
		if p["origin"] != "worker-node" || p["fiber_id"] != "01ARZ3NDEKTSV4RRFFQ69G5FAV" {
			t.Fatal(p)
		}
	}
	if calls[3]["action"] != "cancel" || calls[3]["message_id"] != "later" {
		t.Fatal(calls)
	}
}
