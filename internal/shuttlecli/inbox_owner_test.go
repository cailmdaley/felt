package shuttlecli

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/cailmdaley/felt/internal/messaging"
)

func TestInboxScheduledRawKeyAndCancel(t *testing.T) {
	env := testEnv(t)
	a := newApp(env)
	for _, e := range []messaging.InboxEntry{
		{Address: "/store:raw", Request: messaging.Request{MessageID: "later", Text: "check the fit\nmore"}, Wishes: messaging.Wishes{NotBefore: "2999-01-01T00:00:00Z"}},
		{Address: "/store:raw", Request: messaging.Request{MessageID: "quiet", Text: "quiet"}},
	} {
		if err := messaging.Enqueue(env, e); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := a.listInbox("/store:raw", true)
	if err != nil || len(entries) != 1 || entries[0].Text != "check the fit" {
		t.Fatalf("%+v %v", entries, err)
	}
	cmd := a.shuttleInboxCmd()
	cmd.SetArgs([]string{"cancel", "/store:raw", "later"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	entries, err = a.listInbox("/store:raw", true)
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
	cmd := a.shuttleInboxCmd()
	cmd.SetArgs([]string{"cancel", "worker", "later"})
	if err := cmd.Execute(); err != nil {
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

// A raw key is read on this host without resolving it as a fiber, and a
// session id is a session without looking for a fiber: neither asks the
// daemon for its fiber feed.
func TestRawKeysAndSessionIDsSkipFiberLookup(t *testing.T) {
	env := testEnv(t)
	store := writeMessageTargetFiber(t, map[string]any{"kind": "oneshot", "host": "worker-node", "agent": "claude-opus", "project_dir": t.TempDir()})
	isolateMessageFiberStore(env, store)
	var composite atomic.Int32
	daemonStub(t, env, map[string]http.HandlerFunc{"/api/v1/fibers/composite": func(w http.ResponseWriter, r *http.Request) {
		composite.Add(1)
		w.Write([]byte(`{"fibers":[]}`))
	}})
	key := "/no/such/store:" + messageTargetFiberUID
	if err := messaging.Enqueue(env, messaging.InboxEntry{Address: key, Request: messaging.Request{MessageID: "m", Text: "x"}}); err != nil {
		t.Fatal(err)
	}
	a := newApp(env)
	if entries, err := a.listInbox(key, false); err != nil || len(entries) != 1 {
		t.Fatalf("%+v %v", entries, err)
	}
	if f, _ := a.messageFiber("1acfcea5-69c7-483b-9375-0026eb45f5c0"); f != nil {
		t.Fatalf("a session id resolved to fiber %s", f.ID)
	}
	if n := composite.Load(); n != 0 {
		t.Fatalf("fetched the fiber feed %d time(s)", n)
	}
}

// A reference that names no fiber is an error, not an empty inbox.
func TestInboxUnknownFiberIsAnError(t *testing.T) {
	env := testEnv(t)
	store := writeMessageTargetFiber(t, map[string]any{"kind": "oneshot", "host": "worker-node", "agent": "claude-opus", "project_dir": t.TempDir()})
	isolateMessageFiberStore(env, store)
	daemonStub(t, env, map[string]http.HandlerFunc{"/api/v1/fibers/composite": jsonBody(`{"fibers":[]}`)})
	a := newApp(env)
	if _, err := a.listInbox("work/wroker", true); err == nil || !strings.Contains(err.Error(), `no fiber "work/wroker"`) {
		t.Fatalf("ls: %v", err)
	}
	if err := a.cancelInbox("work/wroker", "msg-1"); err == nil || !strings.Contains(err.Error(), `no fiber "work/wroker"`) {
		t.Fatalf("cancel: %v", err)
	}
}
