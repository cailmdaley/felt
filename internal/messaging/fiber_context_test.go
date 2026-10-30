package messaging

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

func transition(t *testing.T, env *sysenv.Env, identity, address string) uint64 {
	t.Helper()
	n, err := TransitionFiberReceiver(env, "fiber", "host", identity, address)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// Registration/removal/rotation must fence the old hook before any delivery.
func TestFiberContextWorkerTransitions(t *testing.T) {
	t.Parallel()
	for _, successor := range []string{"B", "unavailable", "removed", "rotation"} {
		t.Run(successor, func(t *testing.T) {
			env := testEnv(t)
			for _, id := range []string{"A", "B"} {
				if err := RegisterMailbox(env, "claude", id, "host", t.TempDir(), os.Getpid(), true); err != nil {
					t.Fatal(err)
				}
			}
			a := "shuttle://host/claude/A"
			first := transition(t, env, "execution-A:A", a)
			if err := DeliverFiberContext(context.Background(), env, "fiber", "host", a, first); err != nil {
				t.Fatal(err)
			}
			if err := QueueFiberContext(env, "fiber", Request{MessageID: "result", Text: "original"}); err != nil {
				t.Fatal(err)
			}
			b, identity := "shuttle://host/claude/B", "execution-B:B"
			switch successor {
			case "removed":
				b, identity = "-", ""
			case "unavailable":
				b = "shuttle://host/claude/missing"
			case "rotation":
				identity = "execution-A:B"
			}
			second := transition(t, env, identity, b)
			if second <= first {
				t.Fatal("epoch did not advance")
			}
			// Delayed delivery selection cannot designate A, and stale hooks cannot emit.
			if err := DeliverFiberContext(context.Background(), env, "fiber", "host", a, first); err == nil {
				t.Fatal("stale selection succeeded")
			}
			if err := OfferMailbox(env, "claude", "A", "host", func(batch []Request) error { t.Errorf("stale A emitted: %+v", batch); return nil }); err != nil {
				t.Fatal(err)
			}
			// A fresh Env/process can re-adopt the same worker without changing the epoch.
			if n := transition(t, env, identity, b); n != second {
				t.Fatal("re-adoption changed epoch")
			}
			for i := 0; i < 3; i++ {
				_ = DeliverFiberContext(context.Background(), env, "fiber", "host", b, second)
			}
			if n := transition(t, env, identity, b); n != second {
				t.Fatal("flush changed epoch")
			}
			if successor == "removed" || successor == "unavailable" {
				second = transition(t, env, "execution-B:B", "shuttle://host/claude/B")
			}
			if err := DeliverFiberContext(context.Background(), env, "fiber", "host", "shuttle://host/claude/B", second); err != nil {
				t.Fatal(err)
			}
			failed := errors.New("output failed")
			if err := OfferMailbox(env, "claude", "B", "host", func([]Request) error { return failed }); !errors.Is(err, failed) {
				t.Fatalf("failed emission: %v", err)
			}
			var got []Request
			for i := 0; i < 2; i++ {
				if err := OfferMailbox(env, "claude", "B", "host", func(batch []Request) error { got = append(got, batch...); return nil }); err != nil {
					t.Fatal(err)
				}
				if err := QueueFiberContext(env, "fiber", Request{MessageID: "result", Text: "original"}); err != nil {
					t.Fatal(err)
				}
			}
			if len(got) != 1 || got[0].Text != "original" {
				t.Fatalf("received: %+v", got)
			}
		})
	}
}

func TestFiberContextAuthorityFailures(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	a := "shuttle://host/claude/A"
	first := transition(t, env, "A", a)
	if _, err := TransitionFiberReceiver(env, "fiber", "host", "B", "shuttle://other/claude/B"); err == nil {
		t.Fatal("foreign owner accepted")
	}
	if n := transition(t, env, "A", a); n != first {
		t.Fatal("invalid transition changed authority")
	}
	path := filepath.Join(mailboxDir(env, "fiber", "fiber"), "destination.json")
	if err := os.WriteFile(path, []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := TransitionFiberReceiver(env, "fiber", "host", "B", "-"); err == nil {
		t.Fatal("corruption reset authority")
	}
	if err := DeliverFiberContext(context.Background(), env, "fiber", "host", a, first); err == nil {
		t.Fatal("corrupt authority accepted")
	}
}

func TestFiberContextWakeUsesNativeTurnAndDoesNotReplay(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	_, sent := nativeClaudeFixture(t, env, func(frame map[string]any, transcript *os.File) { nativeRows(frame, transcript, false) })
	a := "shuttle://host/claude/session"
	epoch := transition(t, env, "execution:session", a)
	req := Request{MessageID: "closed-result", Text: "thread child closed: measured", Wake: true}
	for i := 0; i < 2; i++ {
		if err := QueueFiberContext(env, "fiber", req); err != nil {
			t.Fatal(err)
		}
		if err := DeliverFiberContext(context.Background(), env, "fiber", "host", a, epoch); err != nil {
			t.Fatal(err)
		}
	}
	if sent.Load() != 1 {
		t.Fatalf("native turns = %d", sent.Load())
	}
}

func TestPendingFiberContextCountsWhatNoWorkerHasTaken(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	if n, err := PendingFiberContext(env, "fiber"); err != nil || n != 0 {
		t.Fatalf("a fiber with no mailbox holds %d (%v), want 0", n, err)
	}
	for _, id := range []string{"one", "two", "two"} {
		if err := QueueFiberContext(env, "fiber", Request{MessageID: id, Text: "context " + id}); err != nil {
			t.Fatal(err)
		}
	}
	if n, err := PendingFiberContext(env, "fiber"); err != nil || n != 2 {
		t.Fatalf("pending = %d (%v), want 2", n, err)
	}
	if err := RegisterMailbox(env, "claude", "A", "host", t.TempDir(), os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	a := "shuttle://host/claude/A"
	generation := transition(t, env, "execution-A:A", a)
	if err := DeliverFiberContext(context.Background(), env, "fiber", "host", a, generation); err != nil {
		t.Fatal(err)
	}
	// A hook-ready receiver takes context on its next hook, not at delivery.
	if err := OfferMailbox(env, "claude", "A", "host", func([]Request) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if n, err := PendingFiberContext(env, "fiber"); err != nil || n != 0 {
		t.Fatalf("after its worker took them, pending = %d (%v), want 0", n, err)
	}
}

func TestFiberContextHandoffKeepsPerMessageAckAfterLaterFailure(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	for _, id := range []string{"first", "second"} {
		if err := QueueFiberContext(env, "fiber", Request{MessageID: id, Text: id}); err != nil {
			t.Fatal(err)
		}
	}
	root := mailboxDir(env, "fiber", "fiber")
	var firstWorker []string
	failure := errors.New("later delivery failed")
	err := offerMailboxEachValidated(root, func(Request) bool { return true }, nil, func(request Request) error {
		firstWorker = append(firstWorker, request.MessageID)
		if request.MessageID == "second" {
			return failure
		}
		return nil
	})
	if !errors.Is(err, failure) {
		t.Fatalf("first worker error = %v", err)
	}
	if len(firstWorker) != 2 || firstWorker[0] != "first" || firstWorker[1] != "second" {
		t.Fatalf("first worker received %v", firstWorker)
	}

	var successor []string
	if err := offerMailboxEachValidated(root, func(Request) bool { return true }, nil, func(request Request) error {
		successor = append(successor, request.MessageID)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(successor) != 1 || successor[0] != "second" {
		t.Fatalf("successor received %v; acknowledged first message replayed", successor)
	}
}

func TestFiberContextRestartRetriesPinnedDestinationAfterAcceptedSend(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	request := Request{MessageID: "thread-accepted", Text: "thread hub/child closed: done"}
	if err := QueueFiberContext(env, "fiber", request); err != nil {
		t.Fatal(err)
	}
	firstGeneration := transition(t, env, "execution-first", "shuttle://host/claude/first")
	var firstID string
	accepted := func(_ context.Context, _ *sysenv.Env, _ string, req Request, address string) (Receipt, error) {
		firstID = req.MessageID + "-" + mailboxKey(address)[:16]
		return Receipt{Status: StatusContextAdded}, nil
	}
	if err := deliverFiberContextItemWith(context.Background(), env, "fiber", "host", "shuttle://host/claude/first", request, accepted); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending", mailboxKey(request.MessageID)+".json")
	entry, err := readFiberMailboxEntry(path)
	if err != nil || entry.AttemptAddress != "shuttle://host/claude/first" {
		t.Fatalf("durable attempt = %+v, %v", entry, err)
	}
	if fiberContextHookEligible(mailboxDir(env, "fiber", "fiber"), request) {
		t.Fatal("hook path bypassed a pinned direct delivery attempt")
	}
	successorGeneration := transition(t, env, "execution-successor", "shuttle://host/claude/successor")
	successorTarget, err := ParseAddress("shuttle://host/claude/successor")
	if err != nil {
		t.Fatal(err)
	}
	if !fiberContextDirectEligible(mailboxDir(env, "fiber", "fiber"), request, successorGeneration, true, successorTarget) {
		t.Fatalf("direct recovery was fenced by selected generation %d (first was %d)", successorGeneration, firstGeneration)
	}

	var successorAddress, successorID string
	retry := func(_ context.Context, _ *sysenv.Env, _ string, req Request, address string) (Receipt, error) {
		successorAddress = address
		successorID = req.MessageID + "-" + mailboxKey(address)[:16]
		return Receipt{Status: StatusContextAdded}, nil
	}
	if err := deliverFiberContextItemWith(context.Background(), env, "fiber", "host", "shuttle://host/claude/successor", request, retry); err != nil {
		t.Fatal(err)
	}
	if successorAddress != "shuttle://host/claude/first" || successorID != firstID {
		t.Fatalf("restart retried %q with id %q; first attempt was %q with id %q", successorAddress, successorID, "shuttle://host/claude/first", firstID)
	}
}

func TestFiberContextRetargetsAfterPinnedDestinationRejects(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	request := Request{MessageID: "thread-rejected", Text: "thread hub/child closed: done"}
	if err := QueueFiberContext(env, "fiber", request); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending", mailboxKey(request.MessageID)+".json")
	entry, err := readFiberMailboxEntry(path)
	if err != nil {
		t.Fatal(err)
	}
	first := "shuttle://host/claude/first"
	if err := writeFiberMailboxAttempt(path, entry, first); err != nil {
		t.Fatal(err)
	}
	var addresses []string
	sender := func(_ context.Context, _ *sysenv.Env, _ string, _ Request, address string) (Receipt, error) {
		addresses = append(addresses, address)
		if address == first {
			return Receipt{Status: StatusRejected}, errCode("unavailable", "old receiver ended")
		}
		return Receipt{Status: StatusContextAdded}, nil
	}
	selected := "shuttle://host/claude/successor"
	if err := deliverFiberContextItemWith(context.Background(), env, "fiber", "host", selected, request, sender); err != nil {
		t.Fatal(err)
	}
	if len(addresses) != 2 || addresses[0] != first || addresses[1] != selected {
		t.Fatalf("delivery attempts = %v, want rejected first then current successor", addresses)
	}
	entry, err = readFiberMailboxEntry(path)
	if err != nil || entry.AttemptAddress != selected {
		t.Fatalf("successor attempt = %+v, %v", entry, err)
	}
}

func TestThreadSignalMailboxDropsSupersededAndRetainsWhenCheckFails(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	for _, id := range []string{"thread-superseded", "thread-unavailable", "thread-healthy"} {
		if err := QueueFiberContext(env, "fiber", Request{MessageID: id, Text: "thread hub/child asked: question"}); err != nil {
			t.Fatal(err)
		}
	}
	root := mailboxDir(env, "fiber", "fiber")
	if err := offerMailboxValidated(root, func(r Request) bool { return r.MessageID == "thread-superseded" }, func(context.Context, Request) (bool, error) {
		return false, nil
	}, func([]Request) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if n, err := PendingFiberContext(env, "fiber"); err != nil || n != 2 {
		t.Fatalf("pending after superseded drop = %d (%v), want 2", n, err)
	}
	checkFailure := errors.New("validator unavailable")
	healthyChecked := make(chan struct{})
	var healthyOnce sync.Once
	var delivered []string
	if err := offerMailboxValidated(root, func(Request) bool { return true }, func(_ context.Context, r Request) (bool, error) {
		if r.MessageID == "thread-unavailable" {
			select {
			case <-healthyChecked:
			case <-time.After(2 * time.Second):
				return false, errors.New("healthy notice waited behind unreachable owner")
			}
			return false, checkFailure
		}
		healthyOnce.Do(func() { close(healthyChecked) })
		return true, nil
	}, func(batch []Request) error {
		for _, request := range batch {
			delivered = append(delivered, request.MessageID)
		}
		return nil
	}); !errors.Is(err, checkFailure) {
		t.Fatalf("validator error = %v", err)
	}
	if len(delivered) != 1 || delivered[0] != "thread-healthy" {
		t.Fatalf("healthy notice delivery = %v", delivered)
	}
	if n, err := PendingFiberContext(env, "fiber"); err != nil || n != 1 {
		t.Fatalf("pending after unavailable check = %d (%v), want 1", n, err)
	}
}

func TestCurrentThreadSignalInvokesShuttleFromEnvironmentPath(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	bin := filepath.Join(t.TempDir(), "bin")
	if err := os.MkdirAll(bin, 0o700); err != nil {
		t.Fatal(err)
	}
	stub := filepath.Join(bin, "shuttle")
	if err := os.WriteFile(stub, []byte("#!/bin/sh\n[ \"$1\" = thread-signal-current ] || exit 2\nprintf '%s\\n' '{\"current\":true}'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	env.Set("PATH", bin+string(os.PathListSeparator)+env.Getenv("PATH"))
	current, err := currentThreadSignal(context.Background(), env, Request{
		MessageID: "thread-id",
		Text:      "thread hub/child asked: question",
		ThreadSignal: &ThreadSignal{
			UID: "child-uid", Verb: "asked", Stamp: "2026-10-30T00:00:00Z", Owner: "candide",
		},
	})
	if err != nil || !current {
		t.Fatalf("current thread signal = %v, %v", current, err)
	}
}

func TestThreadSignalContractSkewClassifierIsNarrow(t *testing.T) {
	for _, test := range []struct {
		message string
		want    bool
	}{
		{"unknown command \\\"thread-signal-current\\\" for \\\"shuttle\\\"", true},
		{"daemon at http://127.0.0.1:4000/api/v1/thread-signals/current returned 404: {\"errors\":{\"detail\":\"Not Found\"}}", true},
		{"daemon at http://127.0.0.1:4000/api/v1/thread-signals/current returned 404: {\"error\":\"fiber_not_found\"}", false},
		{"daemon at http://127.0.0.1:4000/api/v1/thread-signals/current returned 404: Not Found", false},
		{"POST /api/v1/thread-signals/current: 404 page not found", false},
		{"POST /api/v1/thread-signals/current: 404 fiber not found", false},
		{"POST /api/v1/thread-signals/current: connection refused", false},
		{"POST /api/v1/fibers/child: 404 page not found", false},
	} {
		if got := isThreadSignalContractSkew(errors.New(test.message)); got != test.want {
			t.Errorf("isThreadSignalContractSkew(%q) = %v, want %v", test.message, got, test.want)
		}
	}
}

func TestCurrentThreadSignalRecognizesMissingRouteFromCLIStderr(t *testing.T) {
	for _, body := range []string{"daemon at http://127.0.0.1:4000/api/v1/thread-signals/current returned 404: {\"errors\":{\"detail\":\"Not Found\"}}", "unknown command \\\"thread-signal-current\\\" for \\\"shuttle\\\""} {
		t.Run(body, func(t *testing.T) {
			env := testEnv(t)
			bin := t.TempDir()
			stub := filepath.Join(bin, "shuttle")
			script := "#!/bin/sh\necho '" + body + "' >&2\nexit 1\n"
			if err := os.WriteFile(stub, []byte(script), 0o700); err != nil {
				t.Fatal(err)
			}
			env.Set("PATH", bin+string(os.PathListSeparator)+env.Getenv("PATH"))
			request := Request{MessageID: "thread-id", Text: "closed", ThreadSignal: &ThreadSignal{UID: "child", Verb: "closed", Stamp: time.Now().UTC().Format(time.RFC3339Nano), Owner: "host"}}
			_, err := currentThreadSignal(context.Background(), env, request)
			var skew threadSignalSkewError
			if !errors.As(err, &skew) {
				t.Fatalf("missing-route error = %v, want a contract-skew error", err)
			}
		})
	}
}

func TestFiberContextUnknownRolloverRequiresEndedEvidence(t *testing.T) {
	for _, ended := range []bool{false, true} {
		t.Run(fmt.Sprint(ended), func(t *testing.T) {
			env := testEnv(t)
			request := Request{MessageID: "unknown-result", Text: "thread child closed: done"}
			if err := QueueFiberContext(env, "fiber", request); err != nil {
				t.Fatal(err)
			}
			first, next := "shuttle://host/claude/A", "shuttle://host/claude/B"
			calls := map[string]int{}
			sender := func(ctx context.Context, env *sysenv.Env, _ string, req Request, address string) (Receipt, error) {
				req.Address = address
				req.MessageID += "-" + mailboxKey(address)[:16]
				return withDedup(ctx, env, req, func(context.Context) dedupSendResult {
					calls[address]++
					if address == first {
						return dedupSendResult{Receipt: Receipt{Status: StatusUnknown}, Err: errCode("ambiguous_delivery", "lost reply")}
					}
					if !strings.Contains(req.Text, "Possible repeat:") {
						t.Errorf("successor notice lacks repeat warning: %q", req.Text)
					}
					return dedupSendResult{Receipt: Receipt{Status: StatusContextAdded}}
				})
			}
			if err := deliverFiberContextItemWith(context.Background(), env, "fiber", "host", first, request, sender); err == nil {
				t.Fatal("unknown outcome acknowledged")
			}
			if ended {
				if err := RegisterMailbox(env, "claude", "A", "host", "/project", os.Getpid(), true); err != nil {
					t.Fatal(err)
				}
				if err := RegisterMailbox(env, "claude", "A", "host", "/project", os.Getpid(), false); err != nil {
					t.Fatal(err)
				}
			}
			for i := 0; i < 2; i++ {
				err := deliverFiberContextItemWith(context.Background(), env, "fiber", "host", next, request, sender)
				if ended && err != nil {
					t.Fatal(err)
				}
				if !ended && err == nil {
					t.Fatal("unreachable receiver treated as ended")
				}
			}
			wantNext := 0
			if ended {
				wantNext = 1
			}
			if calls[first] != 1 || calls[next] != wantNext {
				t.Fatalf("transport calls = %v", calls)
			}
		})
	}
}
