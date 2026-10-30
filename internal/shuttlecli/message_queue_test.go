package shuttlecli

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/cailmdaley/felt/internal/messaging"
)

// dormantDeliverStub answers /api/v1/deliver with status and body, recording
// each request it receives.
func dormantDeliverStub(status int, body string) (http.HandlerFunc, func() []map[string]any) {
	var mu sync.Mutex
	var got []map[string]any
	return func(w http.ResponseWriter, r *http.Request) {
			var request map[string]any
			_ = json.NewDecoder(r.Body).Decode(&request)
			mu.Lock()
			got = append(got, request)
			mu.Unlock()
			w.WriteHeader(status)
			_, _ = w.Write([]byte(body))
		}, func() []map[string]any {
			mu.Lock()
			defer mu.Unlock()
			return append([]map[string]any(nil), got...)
		}
}

func runMessage(t *testing.T, app *app, args ...string) (string, string, error) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	app.env.Stdout = &stdout
	var opts messageOptions
	cmd := app.messageCmd(&opts)
	opts.id, opts.from = "msg-next-worker", "test sender"
	cmd.SetIn(strings.NewReader(""))
	cmd.SetOut(io.Discard)
	cmd.SetErr(&stderr)
	err := cmd.RunE(cmd, args)
	return stdout.String(), stderr.String(), err
}

func TestMessageToDormantFiberQueuesForNextWorker(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	store := writeMessageTargetFiber(t, map[string]any{
		"kind": "oneshot", "host": "worker-node", "agent": "claude-opus", "project_dir": t.TempDir(),
	})
	isolateMessageFiberStore(env, store)
	deliver, requests := dormantDeliverStub(http.StatusAccepted,
		`{"delivery":"context","queued":true,"delivered":false,"status":"queued_for_next_worker","fiber_id":"`+messageTargetFiberUID+`"}`)
	daemonStub(t, env, map[string]http.HandlerFunc{"/api/v1/deliver": deliver})

	stdout, _, err := runMessage(t, newApp(env), "work/worker", "read this when you start")
	if err != nil {
		t.Fatal(err)
	}
	if want := "queued for work/worker's next worker (msg-next-worker)\n"; stdout != want {
		t.Fatalf("receipt = %q, want %q", stdout, want)
	}
	got := requests()
	if len(got) != 1 {
		t.Fatalf("deliver requests = %d, want 1", len(got))
	}
	want := map[string]any{
		"fiber_id": messageTargetFiberUID, "origin": "worker-node", "text": "read this when you start",
		"from": "external", "from_claim": "test sender", "message_id": "msg-next-worker", "context_only": true, "unless_live": true, "wake": true,
	}
	for key, value := range want {
		if got[0][key] != value {
			t.Errorf("deliver %s = %v, want %v", key, got[0][key], value)
		}
	}
}

func TestMessageToDormantFiberJSONReceiptNeverClaimsDelivery(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	store := writeMessageTargetFiber(t, map[string]any{
		"kind": "oneshot", "host": "worker-node", "agent": "claude-opus", "project_dir": t.TempDir(),
	})
	isolateMessageFiberStore(env, store)
	deliver, requests := dormantDeliverStub(http.StatusAccepted, `{"delivery":"context","queued":true,"delivered":false}`)
	daemonStub(t, env, map[string]http.HandlerFunc{"/api/v1/deliver": deliver})

	app := newApp(env)
	app.json = true
	stdout, _, err := runMessage(t, app, "work/worker", "context please")
	if err != nil {
		t.Fatal(err)
	}
	var receipt map[string]any
	if err := json.Unmarshal([]byte(stdout), &receipt); err != nil {
		t.Fatalf("receipt %q: %v", stdout, err)
	}
	if receipt["status"] != "queued_for_next_worker" || receipt["fiber"] != "work/worker" || receipt["message_id"] != "msg-next-worker" {
		t.Fatalf("receipt = %v", receipt)
	}
	if strings.Contains(stdout, "deliver") && !strings.Contains(stdout, "not delivered") {
		t.Fatalf("receipt claims delivery: %s", stdout)
	}
	if len(requests()) != 1 {
		t.Fatalf("deliver requests = %d, want 1", len(requests()))
	}
}

func TestMessageToLiveFiberSendsToItsWorker(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	store := writeMessageTargetFiber(t, map[string]any{
		"kind": "oneshot", "host": "worker-node", "agent": "claude-opus", "project_dir": t.TempDir(),
		"runtime": map[string]any{"session_uuid": messageTargetSession},
	})
	isolateMessageFiberStore(env, store)
	ledger, _ := json.Marshal(sessionLedgerResponse{
		Records: []SessionProvenance{{Fiber: "work/worker", UID: messageTargetFiberUID, Session: messageTargetSession, Host: "worker-node", Harness: "claude", At: 1, Kind: "dispatch"}},
		Origins: map[string]any{"worker-node": map[string]any{"stale": false, "last_error": nil}},
	})
	peers, _ := json.Marshal(messaging.Directory{Sessions: []messaging.Session{}, Gaps: []messaging.Gap{}})
	deliver, requests := dormantDeliverStub(http.StatusConflict, `{"delivery":"context","queued":false,"live":true}`)
	var posted messaging.Request
	daemonStub(t, env, map[string]http.HandlerFunc{
		"/api/v1/deliver":     deliver,
		"/api/v1/peers":       jsonBody(string(peers)),
		sessionsCompositePath: jsonBody(string(ledger)),
		"/api/v1/messages": func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewDecoder(r.Body).Decode(&posted)
			_ = json.NewEncoder(w).Encode(messaging.Receipt{MessageID: posted.MessageID, Address: posted.Address, Status: messaging.StatusAccepted, Transport: "claude-native"})
		},
	})

	app := newApp(env)
	app.dir = store
	stdout, _, err := runMessage(t, app, "work/worker", "steer now")
	if err != nil {
		t.Fatal(err)
	}
	got := requests()
	if len(got) != 1 || got[0]["fiber_id"] != messageTargetFiberUID || got[0]["unless_live"] != true {
		t.Fatalf("live-check requests = %v, want one conditional queue request for the private fiber", got)
	}
	if posted.Text != "steer now" || posted.MessageID != "msg-next-worker" {
		t.Fatalf("direct message = %+v", posted)
	}
	if want := "shuttle://worker-node/claude/" + messageTargetSession; posted.Address != want {
		t.Fatalf("posted to %q, want the live worker %q", posted.Address, want)
	}
	if !strings.HasPrefix(stdout, "accepted ") {
		t.Fatalf("receipt = %q", stdout)
	}
}

func TestMessageToRemoteLiveFiberSucceedsWhenLocalAskCleanupCannotResolveIt(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	ownHost(t, env, "sender-node")
	project, _ := newStore(t)
	env.Chdir(project)
	store := writeMessageTargetFiber(t, map[string]any{
		"kind": "oneshot", "host": "worker-node", "agent": "claude-opus", "project_dir": t.TempDir(),
		"ask":     map[string]any{"text": "Already answered?", "at": "2026-10-28T10:00:00Z"},
		"runtime": map[string]any{"session_uuid": messageTargetSession},
	})
	isolateMessageFiberStore(env, store)
	ledger, _ := json.Marshal(sessionLedgerResponse{
		Records: []SessionProvenance{{Fiber: "work/worker", UID: messageTargetFiberUID, Session: messageTargetSession, Host: "worker-node", Harness: "claude", At: 1, Kind: "dispatch"}},
		Origins: map[string]any{"worker-node": map[string]any{"stale": false, "last_error": nil}},
	})
	peers, _ := json.Marshal(messaging.Directory{Sessions: []messaging.Session{}, Gaps: []messaging.Gap{}})
	deliver, _ := dormantDeliverStub(http.StatusConflict, `{"delivery":"context","queued":false,"live":true}`)
	daemonStub(t, env, map[string]http.HandlerFunc{
		"/api/v1/deliver":     deliver,
		"/api/v1/peers":       jsonBody(string(peers)),
		sessionsCompositePath: jsonBody(string(ledger)),
		"/api/v1/messages": func(w http.ResponseWriter, r *http.Request) {
			var posted messaging.Request
			if err := json.NewDecoder(r.Body).Decode(&posted); err != nil {
				t.Errorf("decode direct message: %v", err)
				return
			}
			_ = json.NewEncoder(w).Encode(messaging.Receipt{
				MessageID: posted.MessageID, Address: posted.Address,
				Status: messaging.StatusAccepted, Transport: "claude-native",
			})
		},
	})

	// The shared store resolves the remote fiber, but this checkout's project
	// scope cannot load it after delivery.
	app := newApp(env)
	stdout, stderr, err := runMessage(t, app, "work/worker", "steer now")
	if err != nil {
		t.Fatalf("successful delivery was reported as failure: %v", err)
	}
	if strings.Contains(stderr, "couldn't clear the fiber's outstanding question") {
		t.Fatalf("remote fiber received a local cleanup warning: %q", stderr)
	}
	if !strings.HasPrefix(stdout, "accepted ") {
		t.Fatalf("receipt = %q", stdout)
	}
}

func TestMessageToFiberWithoutShuttleBlockIsStillAnError(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	store, storage := newStore(t)
	seedFiber(t, storage, "work/plain", "01ARZ3NDEKTSV4RRFFQ69G5FAW", "open", nil, nil)
	isolateMessageFiberStore(env, store)
	deliver, requests := dormantDeliverStub(http.StatusAccepted, `{"delivery":"context","queued":true}`)
	peers, _ := json.Marshal(messaging.Directory{Sessions: []messaging.Session{}, Gaps: []messaging.Gap{}})
	ledger, _ := json.Marshal(sessionLedgerResponse{Records: []SessionProvenance{}, Origins: map[string]any{}})
	daemonStub(t, env, map[string]http.HandlerFunc{
		"/api/v1/deliver":     deliver,
		"/api/v1/peers":       jsonBody(string(peers)),
		sessionsCompositePath: jsonBody(string(ledger)),
	})

	_, _, err := runMessage(t, newApp(env), "work/plain", "hello")
	if err == nil || !strings.Contains(err.Error(), "no shuttle block") {
		t.Fatalf("a fiber with no shuttle block must be refused, got %v", err)
	}
	if len(requests()) != 0 {
		t.Fatal("a fiber with no shuttle block must not queue")
	}
}

func TestContextMailboxPendingCountsEachFiber(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("SHUTTLE_DATA_DIR", t.TempDir())
	for _, id := range []string{"a", "b"} {
		if err := messaging.QueueFiberContext(env, "store:WAITING", messaging.Request{MessageID: id, Text: "x"}); err != nil {
			t.Fatal(err)
		}
	}
	var stdout bytes.Buffer
	env.Stdout = &stdout
	cmd := newApp(env).contextMailboxCmd()
	cmd.SetArgs([]string{"pending", "store:WAITING", "store:EMPTY"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	var got map[string]int
	if err := json.Unmarshal(stdout.Bytes(), &got); err != nil {
		t.Fatalf("%q: %v", stdout.String(), err)
	}
	if len(got) != 2 || got["store:WAITING"] != 2 || got["store:EMPTY"] != 0 {
		t.Fatalf("pending = %v", got)
	}
}

func TestThreadSignalCurrentPostsStructuredIdentity(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	var got messaging.ThreadSignalCheck
	daemonStub(t, env, map[string]http.HandlerFunc{
		"/api/v1/thread-signals/current": func(w http.ResponseWriter, r *http.Request) {
			if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
				t.Error(err)
			}
			_, _ = w.Write([]byte(`{"current":true}`))
		},
	})
	var stdout bytes.Buffer
	env.Stdout = &stdout
	cmd := newApp(env).threadSignalCurrentCmd()
	cmd.SetArgs([]string{`{"signal":{"uid":"child-uid","verb":"asked","stamp":"2026-10-30T00:00:00Z","owner":"candide"},"message_id":"thread-id","text":"thread child asked: question"}`})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if got.Signal == nil || got.Signal.UID != "child-uid" || got.Signal.Verb != "asked" || got.Signal.Owner != "candide" || got.MessageID != "thread-id" || got.Text != "thread child asked: question" {
		t.Fatalf("posted signal check = %+v", got)
	}
	if stdout.String() != `{"current":true}`+"\n" {
		t.Fatalf("stdout = %q", stdout.String())
	}
}
