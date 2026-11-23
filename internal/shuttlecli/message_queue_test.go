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

// A waking message to a fiber with no live worker asks its owner to queue it
// and start a session; the receipt says which happened, in the owner's words.
func TestMessageToDormantFiberReportsWhatItsOwnerDid(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, flag, body, want, turn string
	}{
		{"starting", "", `{"delivery":"context","queued":true,"delivered":false,"status":"starting","detail":"work/worker has no live worker; a session is starting"}`,
			"starting a session on work/worker for it (msg-next-worker)\n", "ask"},
		{"forced", "--wake", `{"delivery":"context","queued":true,"delivered":false,"status":"starting"}`,
			"starting a session on work/worker for it (msg-next-worker)\n", "force"},
		{"gated", "", `{"delivery":"context","queued":true,"delivered":false,"status":"queued","detail":"work/worker is at rest; the message waits in its inbox for whoever next works on it"}`,
			"queued for work/worker: work/worker is at rest; the message waits in its inbox for whoever next works on it (msg-next-worker)\n", "ask"},
		{"held", "", `{"delivery":"context","queued":true,"delivered":false,"status":"queued","detail":"worker-node holds new sessions until its boot quarantine is released; one starts for the message then"}`,
			"queued for work/worker: worker-node holds new sessions until its boot quarantine is released; one starts for the message then (msg-next-worker)\n", "ask"},
		{"no detail", "", `{"delivery":"context","queued":true,"delivered":false,"status":"queued"}`,
			"queued for work/worker: not delivered; queued in work/worker's inbox (msg-next-worker)\n", "ask"},
		{"cost hold", "", `{"delivery":"context","queued":true,"delivered":false,"status":"held","consumed":{"action":"wait","held":"cost"}}`,
			"held as context for cost on work/worker; if still unread after an hour, Shuttle escalates it (fresh session, or wakes the worker) (msg-next-worker)\n", "ask"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			store := writeMessageTargetFiber(t, map[string]any{
				"kind": "oneshot", "host": "worker-node", "agent": "claude-opus", "project_dir": t.TempDir(),
			})
			isolateMessageFiberStore(env, store)
			deliver, requests := dormantDeliverStub(http.StatusAccepted, tc.body)
			daemonStub(t, env, map[string]http.HandlerFunc{"/api/v1/deliver": deliver})

			var stdout bytes.Buffer
			app := newApp(env)
			app.env.Stdout = &stdout
			var opts messageOptions
			cmd := app.messageCmd(&opts)
			opts.id, opts.from = "msg-next-worker", "test sender"
			args := []string{"work/worker", "read this when you start"}
			if tc.flag != "" {
				if err := cmd.Flags().Set("wake", "true"); err != nil {
					t.Fatal(err)
				}
			}
			cmd.SetIn(strings.NewReader(""))
			cmd.SetOut(io.Discard)
			cmd.SetErr(io.Discard)
			if err := cmd.RunE(cmd, args); err != nil {
				t.Fatal(err)
			}
			if stdout.String() != tc.want {
				t.Fatalf("receipt = %q, want %q", stdout.String(), tc.want)
			}
			got := requests()
			if len(got) != 1 {
				t.Fatalf("deliver requests = %d, want 1", len(got))
			}
			want := map[string]any{
				"fiber_id": messageTargetFiberUID, "origin": "worker-node", "text": "read this when you start",
				"from": "test sender", "message_id": "msg-next-worker", "context_only": true, "wake": true, "turn": tc.turn,
			}
			for key, value := range want {
				if got[0][key] != value {
					t.Errorf("deliver %s = %v, want %v", key, got[0][key], value)
				}
			}
		})
	}
}

func TestMessageToOwnerOnlyDormantFiberQueuesBeforeAnyWorkerBinding(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	isolateMessageFiberStore(env, "")
	deliver, requests := dormantDeliverStub(http.StatusAccepted, `{"delivery":"context","queued":true,"delivered":false}`)
	feed := `{"fibers":[{"origin":"worker-node","fiber":{"id":"` + messageTargetFiberUID + `","uid":"` + messageTargetFiberUID + `","slug":"science/team/worker","shuttle":{"kind":"oneshot","host":"worker-node"}}}]}`
	daemonStub(t, env, map[string]http.HandlerFunc{
		"/api/v1/fibers/composite": jsonBody(feed),
		"/api/v1/deliver":          deliver,
	})
	stdout, _, err := runMessage(t, newApp(env), "science/team/worker", "read this when you start")
	if err != nil || !strings.Contains(stdout, "queued for science/team/worker") {
		t.Fatalf("owner-only queue receipt = %q, %v", stdout, err)
	}
	got := requests()
	if len(got) != 1 || got[0]["fiber_id"] != messageTargetFiberUID || got[0]["origin"] != "worker-node" {
		t.Fatalf("owner-only queue requests = %#v", got)
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
	if receipt["status"] != "queued" || receipt["fiber"] != "work/worker" || receipt["message_id"] != "msg-next-worker" {
		t.Fatalf("receipt = %v", receipt)
	}
	if strings.Contains(stdout, "deliver") && !strings.Contains(stdout, "not delivered") {
		t.Fatalf("receipt claims delivery: %s", stdout)
	}
	if len(requests()) != 1 {
		t.Fatalf("deliver requests = %d, want 1", len(requests()))
	}
}

func TestContextOnlyLiveFiberUsesDurableMailbox(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	store := writeMessageTargetFiber(t, map[string]any{
		"kind": "oneshot", "host": "worker-node", "agent": "claude-opus", "project_dir": t.TempDir(),
		"runtime": map[string]any{"session_uuid": messageTargetSession},
	})
	isolateMessageFiberStore(env, store)
	daemonStub(t, env, map[string]http.HandlerFunc{
		"/api/v1/deliver": func(w http.ResponseWriter, r *http.Request) {
			var payload map[string]any
			_ = json.NewDecoder(r.Body).Decode(&payload)
			if payload["wake"] != false || payload["turn"] != "" {
				t.Error("quiet context requested a turn")
			}
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"queued":true}`))
		},
	})
	app := newApp(env)
	f, block := app.messageFiber("work/worker")
	receipt, err := app.queueInFiber(f, block, messaging.Request{Address: "work/worker", MessageID: "quiet", Text: "follow the fiber"}, false, "")
	if err != nil || receipt == nil {
		t.Fatalf("queue = %+v, %v", receipt, err)
	}
	if strings.Contains(receipt.Detail, "no live worker") {
		t.Fatalf("receipt invents worker absence: %+v", receipt)
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

// --fresh asks the owning daemon for a new session on the fiber with the text
// as its launch directive; a session target has no fiber to start one on.
func TestMessageFreshStartsANewSessionOnTheFiber(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	store := writeMessageTargetFiber(t, map[string]any{
		"kind": "oneshot", "host": "worker-node", "agent": "claude-opus", "project_dir": t.TempDir(),
	})
	isolateMessageFiberStore(env, store)
	deliver, requests := dormantDeliverStub(http.StatusOK, `{"delivery":"dispatch","delivered":true}`)
	daemonStub(t, env, map[string]http.HandlerFunc{"/api/v1/deliver": deliver})

	fresh := func(target string) (string, error) {
		var stdout bytes.Buffer
		a := newApp(env)
		a.env.Stdout = &stdout
		var opts messageOptions
		cmd := a.messageCmd(&opts)
		opts.id, opts.from, opts.fresh = "msg-fresh", "test sender", true
		cmd.SetIn(strings.NewReader(""))
		cmd.SetOut(io.Discard)
		cmd.SetErr(io.Discard)
		err := cmd.RunE(cmd, []string{target, "take this from Status"})
		return stdout.String(), err
	}
	stdout, err := fresh("work/worker")
	if err != nil {
		t.Fatal(err)
	}
	if want := "started a fresh session on work/worker (msg-fresh)\n"; stdout != want {
		t.Fatalf("receipt = %q, want %q", stdout, want)
	}
	got := requests()
	if len(got) != 1 {
		t.Fatalf("deliver requests = %d, want 1", len(got))
	}
	request := got[0]
	if request["resume_mode"] != "fresh" || request["fiber_id"] != messageTargetFiberUID || request["origin"] != "worker-node" || request["text"] != "take this from Status" || request["context_only"] != nil {
		t.Fatalf("request = %v", request)
	}
	if _, err := fresh("shuttle://worker-node/claude/11111111-1111-4111-8111-111111111111"); err == nil || !strings.Contains(err.Error(), "--fresh needs a fiber") {
		t.Fatalf("session target: %v", err)
	}
	if len(requests()) != 1 {
		t.Fatal("a session target reached the daemon")
	}
}

// A consume that could not hand a message to the live worker answers queued
// with delivered null: the plain receipt says queued, with the owner's detail
// for a waking send and as the other context receipts read for --context-only.
func TestFailedConsumeReceiptSaysQueued(t *testing.T) {
	t.Parallel()
	const detail = "work/worker's inbox holds it, and its worker takes it from there; the live worker could not be handed it now (session has not registered a Shuttle message hook on this host)"
	body := `{"delivery":"context","queued":true,"delivered":null,"status":"queued","detail":"` + detail + `"}`
	for _, tc := range []struct {
		name, want  string
		contextOnly bool
	}{
		{"wake", "queued for work/worker: " + detail + " (msg-next-worker)\n", false},
		{"context only", "queued as context for work/worker (msg-next-worker)\n", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			store := writeMessageTargetFiber(t, map[string]any{
				"kind": "oneshot", "host": "worker-node", "agent": "claude-opus", "project_dir": t.TempDir(),
			})
			isolateMessageFiberStore(env, store)
			deliver, _ := dormantDeliverStub(http.StatusAccepted, body)
			daemonStub(t, env, map[string]http.HandlerFunc{"/api/v1/deliver": deliver})
			app := newApp(env)
			var stdout bytes.Buffer
			app.env.Stdout = &stdout
			var opts messageOptions
			cmd := app.messageCmd(&opts)
			opts.id, opts.from = "msg-next-worker", "test sender"
			opts.contextOnly = tc.contextOnly
			cmd.SetIn(strings.NewReader(""))
			cmd.SetOut(io.Discard)
			cmd.SetErr(io.Discard)
			if err := cmd.RunE(cmd, []string{"work/worker", "read this"}); err != nil {
				t.Fatal(err)
			}
			if stdout.String() != tc.want {
				t.Fatalf("receipt = %q, want %q", stdout.String(), tc.want)
			}
		})
	}
}
