package messaging

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

var dormant = Worker{Address: "-"}

func neverSend(t *testing.T) fiberContextSender {
	return func(context.Context, *sysenv.Env, string, Request, string) (Receipt, error) {
		t.Fatal("a fiber with no worker sent a batch")
		return Receipt{}, nil
	}
}

// lapseLease moves the fiber's launch reservation back past its lease.
func lapseLease(t *testing.T, env *sysenv.Env) {
	t.Helper()
	root := mailboxDir(env, "fiber", "fiber")
	r, err := readLaunchReservation(root)
	if err != nil || r.OpenedAt == 0 {
		t.Fatalf("no reservation to lapse: %+v %v", r, err)
	}
	r.OpenedAt = time.Now().Add(-launchLease - time.Second).UnixNano()
	bytes, _ := json.Marshal(r)
	if err := mailboxWrite(launchReservationPath(root), bytes, false); err != nil {
		t.Fatal(err)
	}
}

func TestConsumeWithoutAWorkerLaunchesOncePerLease(t *testing.T) {
	for _, turn := range []string{"ask", "idle", "force"} {
		t.Run(turn, func(t *testing.T) {
			env := testEnv(t)
			putWish(t, env, "quiet", "none", "hold")
			putWish(t, env, "m", turn, "hold")
			result, err := consumeWith(context.Background(), env, "fiber", "host", dormant, neverSend(t))
			if err != nil || result.Action != "launch" || !slices.Equal(result.Members, []string{"m"}) {
				t.Fatalf("got %+v %v, want a launch for m", result, err)
			}
			for i := 0; i < 3; i++ {
				if result, err := consumeWith(context.Background(), env, "fiber", "host", dormant, neverSend(t)); err != nil || result.Action != "wait" || !result.Launching {
					t.Fatalf("a launch in its lease was asked for again: %+v %v", result, err)
				}
			}
			if n, err := WakingCount(env, "fiber"); err != nil || n != 0 {
				t.Fatalf("waking count during the lease = %d %v", n, err)
			}
			lapseLease(t, env)
			if n, err := WakingCount(env, "fiber"); err != nil || n != 1 {
				t.Fatalf("waking count after the lease = %d %v", n, err)
			}
			if result, err := consumeWith(context.Background(), env, "fiber", "host", dormant, neverSend(t)); err != nil || result.Action != "launch" {
				t.Fatalf("a lapsed launch was not asked for again: %+v %v", result, err)
			}
			if n, _ := PendingCount(env, "fiber"); n != 2 {
				t.Fatalf("pending = %d; a launch delivers nothing", n)
			}
		})
	}
}

func TestConsumeWithoutAWorkerLeavesQuietEntries(t *testing.T) {
	env := testEnv(t)
	putWish(t, env, "quiet", "none", "hold")
	if result, err := consumeWith(context.Background(), env, "fiber", "host", dormant, neverSend(t)); err != nil || result.Action != "wait" || result.Launching {
		t.Fatalf("quiet context launched a session: %+v %v", result, err)
	}
	if n, _ := WakingCount(env, "fiber"); n != 0 {
		t.Fatalf("waking count = %d for quiet context", n)
	}
	future := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	if err := Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: "later", Text: "later"}, Wishes: Wishes{Turn: "ask", NotBefore: future}}); err != nil {
		t.Fatal(err)
	}
	if result, _ := consumeWith(context.Background(), env, "fiber", "host", dormant, neverSend(t)); result.Action != "wait" {
		t.Fatalf("an entry not yet due launched a session: %+v", result)
	}
	if n, _ := WakingCount(env, "fiber"); n != 0 {
		t.Fatalf("waking count = %d for an entry not yet due", n)
	}
}

// The launched session's first hook takes the whole batch, waking and quiet
// entries alone, and that claim is the delivery. Its link exists from the
// moment it became the receiver, before any consume ran for it.
func TestTheLaunchedSessionsFirstHookTakesTheBatch(t *testing.T) {
	env := testEnv(t)
	for _, wish := range [][2]string{{"quiet", "none"}, {"asked", "ask"}, {"idle", "idle"}, {"forced", "force"}} {
		putWish(t, env, wish[0], wish[1], "hold")
	}
	if result, err := consumeWith(context.Background(), env, "fiber", "host", dormant, neverSend(t)); err != nil || result.Action != "launch" {
		t.Fatalf("got %+v %v", result, err)
	}
	transition(t, env, "launched", "shuttle://host/claude/B")
	if err := RegisterMailbox(env, "claude", "B", "host", t.TempDir(), os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	var got []string
	if err := OfferMailbox(env, "claude", "B", "host", func(batch []Request) error {
		for _, r := range batch {
			got = append(got, r.MessageID)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	slices.Sort(got)
	if !slices.Equal(got, []string{"asked", "forced", "idle", "quiet"}) {
		t.Fatalf("first hook took %v", got)
	}
	if n, _ := PendingCount(env, "fiber"); n != 0 {
		t.Fatalf("pending = %d after the claim", n)
	}
	e := readEntry(t, filepath.Join(mailboxDir(env, "fiber", "fiber"), "offered", mailboxKey("forced")+".json"))
	if e.Attempt == nil || e.Attempt.Outcome != attemptDelivered || e.Attempt.Conversation != "shuttle://host/claude/B" {
		t.Fatalf("delivered attempt = %+v", e.Attempt)
	}
}

// A session that dies before its hook takes the batch leaves it pending: the
// lease lapses, the fiber is dormant again, and the next consume launches
// once more for the same entries.
func TestALaunchedSessionThatNeverTakesTheBatchLeavesItPending(t *testing.T) {
	env := testEnv(t)
	putWish(t, env, "forced", "force", "hold")
	if result, _ := consumeWith(context.Background(), env, "fiber", "host", dormant, neverSend(t)); result.Action != "launch" {
		t.Fatalf("got %+v", result)
	}
	transition(t, env, "launched", "shuttle://host/claude/B")
	transition(t, env, "", "-")
	if result, _ := consumeWith(context.Background(), env, "fiber", "host", dormant, neverSend(t)); result.Action != "wait" {
		t.Fatalf("a launch in its lease was asked for again: %+v", result)
	}
	lapseLease(t, env)
	result, err := consumeWith(context.Background(), env, "fiber", "host", dormant, neverSend(t))
	if err != nil || result.Action != "launch" || !slices.Equal(result.Members, []string{"forced"}) {
		t.Fatalf("got %+v %v after the session died", result, err)
	}
	// A replaced session's link offers nothing.
	if err := RegisterMailbox(env, "claude", "B", "host", t.TempDir(), os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	if err := OfferMailbox(env, "claude", "B", "host", func(batch []Request) error {
		t.Fatalf("a replaced session took %+v", batch)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

// A live worker other than the launched one leaves a reservation to the
// launched session's hook while the lease stands, then is woken for it.
func TestALiveWorkerLeavesALaunchReservationToItsHookUntilTheLeaseLapses(t *testing.T) {
	env := testEnv(t)
	putWish(t, env, "forced", "force", "hold")
	if result, _ := consumeWith(context.Background(), env, "fiber", "host", dormant, neverSend(t)); result.Action != "launch" {
		t.Fatalf("got %+v", result)
	}
	if err := RegisterMailbox(env, "claude", "B", "host", t.TempDir(), os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	w := Worker{Address: "shuttle://host/claude/B", Epoch: transition(t, env, "launched", "shuttle://host/claude/B"), Idle: true}
	if result, err := consumeWith(context.Background(), env, "fiber", "host", w, neverSend(t)); err != nil || result.Action != "wait" {
		t.Fatalf("the launched session was woken for its own reservation: %+v %v", result, err)
	}
	lapseLease(t, env)
	sends := 0
	result, err := consumeWith(context.Background(), env, "fiber", "host", w, func(context.Context, *sysenv.Env, string, Request, string) (Receipt, error) {
		sends++
		return Receipt{Status: StatusAccepted}, nil
	})
	if err != nil || result.Action != "wake" || sends != 1 {
		t.Fatalf("a lapsed reservation was not woken: %+v %v", result, err)
	}
}

// An idle entry starts a turn only in a worker observed idle; a worker whose
// turn state is unknown is woken for ask and left alone for idle.
func TestAnIdleEntryWaitsForAnObservedIdle(t *testing.T) {
	for _, turn := range []string{"idle", "ask"} {
		t.Run(turn, func(t *testing.T) {
			env, w := consumeFixture(t)
			w.Idle, w.Unknown = true, true
			putWish(t, env, "m", turn, "hold")
			sends := 0
			sender := func(_ context.Context, _ *sysenv.Env, _ string, r Request, _ string) (Receipt, error) {
				sends++
				return Receipt{Status: StatusAccepted}, nil
			}
			result, err := consumeWith(context.Background(), env, "fiber", "host", w, sender)
			if err != nil {
				t.Fatal(err)
			}
			if want := map[string]string{"idle": "wait", "ask": "wake"}[turn]; result.Action != want || result.Turn {
				t.Fatalf("got %+v, want %s", result, want)
			}
			if turn == "idle" {
				w.Unknown = false
				if result, err := consumeWith(context.Background(), env, "fiber", "host", w, sender); err != nil || result.Action != "wake" || sends != 1 {
					t.Fatalf("an observed idle did not wake: %+v %v", result, err)
				}
			}
		})
	}
	// A force wake leaves the idle entry out while the turn state is unknown.
	env, w := consumeFixture(t)
	w.Idle, w.Unknown = true, true
	putWish(t, env, "idle", "idle", "hold")
	putWish(t, env, "forced", "force", "hold")
	var text string
	if _, err := consumeWith(context.Background(), env, "fiber", "host", w, func(_ context.Context, _ *sysenv.Env, _ string, r Request, _ string) (Receipt, error) {
		text = r.Text
		return Receipt{Status: StatusAccepted}, nil
	}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(text, "text of idle") || !strings.Contains(text, "text of forced") {
		t.Fatalf("force batch = %q", text)
	}
}

// A tracked worker whose conversation is not yet known ("-" with its epoch)
// waits, as it did before a fiber without a worker could launch.
func TestAnUnaddressedWorkerWaits(t *testing.T) {
	env := testEnv(t)
	putWish(t, env, "forced", "force", "hold")
	epoch := transition(t, env, "worker:-", "-")
	result, err := consumeWith(context.Background(), env, "fiber", "host", Worker{Address: "-", Epoch: epoch}, neverSend(t))
	if err != nil || result.Action != "wait" {
		t.Fatalf("got %+v %v", result, err)
	}
	if r, err := readLaunchReservation(mailboxDir(env, "fiber", "fiber")); err != nil || r.OpenedAt != 0 {
		t.Fatalf("an unaddressed worker reserved a launch: %+v %v", r, err)
	}
	if _, err := consumeWith(context.Background(), env, "fiber", "host", Worker{Address: "-", Epoch: epoch + 1}, neverSend(t)); ErrorCode(err) != "stale_receiver" {
		t.Fatalf("a superseded epoch = %v", err)
	}
}

// A waking batch pinned to a conversation that ended before its outcome was
// known asks for a launch like a free entry. Reserving the launch leaves the
// batch's manifest and pins as they were; the launched session's consume then
// resolves it: the ended conversation is asked again under the pinned
// transport id, and the batch rolls forward to the new receiver marked as a
// possible repeat.
func TestAPinnedWakeToAnEndedConversationLaunchesAReplacement(t *testing.T) {
	env, w := consumeFixture(t)
	putWish(t, env, "wake", "ask", "hold")
	putWish(t, env, "quiet", "none", "hold")
	root := mailboxDir(env, "fiber", "fiber")
	items, err := pendingItems(root)
	if err != nil {
		t.Fatal(err)
	}
	// The consumer pinned the batch, then died before the transport emitted it.
	pinned := newConsumedAttempt(w, items, true)
	pinned.OpenedAt = time.Now().Add(-time.Hour).UnixNano()
	if err := pinConsumedBatch(root, &pinned); err != nil {
		t.Fatal(err)
	}
	// Its receiver exited.
	transition(t, env, "", "-")
	if err := RegisterMailbox(env, "claude", "A", "host", "", os.Getpid(), false); err != nil {
		t.Fatal(err)
	}

	if n, err := WakingCount(env, "fiber"); err != nil || n != 1 {
		t.Fatalf("waking count = %d %v for a pinned waking batch", n, err)
	}
	result, err := consumeWith(context.Background(), env, "fiber", "host", dormant, neverSend(t))
	if err != nil || result.Action != "launch" || !slices.Equal(result.Members, []string{"wake"}) {
		t.Fatalf("got %+v %v, want a launch for the pinned batch", result, err)
	}
	if result, _ := consumeWith(context.Background(), env, "fiber", "host", dormant, neverSend(t)); result.Action != "wait" || !result.Launching {
		t.Fatalf("a launch in its lease was asked for again: %+v", result)
	}
	if n, _ := WakingCount(env, "fiber"); n != 0 {
		t.Fatalf("waking count = %d during the lease", n)
	}
	manifests, err := readBatchManifests(root)
	if err != nil || len(manifests) != 1 || manifests[0].Payload.MessageID != pinned.Payload.MessageID {
		t.Fatalf("reserving a launch changed the batch: %+v %v", manifests, err)
	}
	for _, id := range pinned.Members {
		e := readEntry(t, filepath.Join(root, "pending", mailboxKey(id)+".json"))
		if e.AttemptAddress != w.Address || e.Attempt.Payload.MessageID != pinned.Payload.MessageID {
			t.Fatalf("reserving a launch changed %s's pin: %+v", id, e)
		}
	}

	// The launched session becomes the receiver; its consume advances the batch.
	if err := RegisterMailbox(env, "claude", "B", "host", t.TempDir(), os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	launched := Worker{Address: "shuttle://host/claude/B", Epoch: transition(t, env, "launched", "shuttle://host/claude/B"), Idle: true}
	var sent []Request
	var to []string
	sender := func(_ context.Context, _ *sysenv.Env, _ string, r Request, address string) (Receipt, error) {
		sent, to = append(sent, r), append(to, address)
		if address == w.Address {
			return Receipt{Status: StatusUnknown}, nil
		}
		return Receipt{Status: StatusAccepted}, nil
	}
	result, err = consumeWith(context.Background(), env, "fiber", "host", launched, sender)
	if err != nil || result.Action != "wake" {
		t.Fatalf("the launched session's consume: %+v %v", result, err)
	}
	if len(sent) != 2 || to[0] != w.Address || sent[0].MessageID != pinned.Payload.MessageID || to[1] != launched.Address {
		t.Fatalf("sent %d to %v, want the pinned payload to A then its successor to B", len(sent), to)
	}
	if sent[1].MessageID == pinned.Payload.MessageID || !strings.HasPrefix(sent[1].Text, "Possible repeat:") || !strings.Contains(sent[1].Text, "text of wake") {
		t.Fatalf("roll-forward to B = %+v", sent[1])
	}
	if n, _ := PendingCount(env, "fiber"); n != 0 {
		t.Fatalf("pending = %d after the roll-forward", n)
	}
	e := readEntry(t, filepath.Join(root, "offered", mailboxKey("wake")+".json"))
	if e.Attempt.Outcome != attemptDelivered || e.Attempt.Conversation != launched.Address || !e.PossibleRepeat {
		t.Fatalf("delivered attempt = %+v", e)
	}
}

// A launched Claude session whose first prompt's hook runs before the daemon
// has made it the receiver takes nothing then, and loses nothing: the batch
// stays pending, and its next hook (a tool call or a prompt) after it became
// the receiver takes it. One that never runs another hook is woken with it
// once the lease passes.
func TestALaunchedSessionsHookBeforeItIsTheReceiverLeavesTheBatchPending(t *testing.T) {
	for _, later := range []string{"hook", "wake"} {
		t.Run(later, func(t *testing.T) {
			env := testEnv(t)
			putWish(t, env, "forced", "force", "hold")
			putWish(t, env, "quiet", "none", "hold")
			if result, err := consumeWith(context.Background(), env, "fiber", "host", dormant, neverSend(t)); err != nil || result.Action != "launch" {
				t.Fatalf("got %+v %v", result, err)
			}
			// The terminal started the harness; the daemon has not yet recorded
			// the launch and made it the receiver.
			if err := RegisterMailbox(env, "claude", "B", "host", t.TempDir(), os.Getpid(), true); err != nil {
				t.Fatal(err)
			}
			var got []string
			offer := func() {
				t.Helper()
				if err := OfferMailbox(env, "claude", "B", "host", func(batch []Request) error {
					for _, r := range batch {
						got = append(got, r.MessageID)
					}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			}
			offer()
			if len(got) != 0 {
				t.Fatalf("a session not yet the receiver took %v", got)
			}
			if n, _ := PendingCount(env, "fiber"); n != 2 {
				t.Fatalf("pending = %d after the early hook", n)
			}
			w := Worker{Address: "shuttle://host/claude/B", Epoch: transition(t, env, "launched", "shuttle://host/claude/B"), Idle: true}
			switch later {
			case "hook":
				offer()
				slices.Sort(got)
				if !slices.Equal(got, []string{"forced", "quiet"}) {
					t.Fatalf("the next hook took %v", got)
				}
			case "wake":
				// Within the lease the reserved entries are left to the hook.
				if result, err := consumeWith(context.Background(), env, "fiber", "host", w, neverSend(t)); err != nil || result.Action != "wait" {
					t.Fatalf("woken within the lease: %+v %v", result, err)
				}
				lapseLease(t, env)
				var text string
				result, err := consumeWith(context.Background(), env, "fiber", "host", w, func(_ context.Context, _ *sysenv.Env, _ string, r Request, _ string) (Receipt, error) {
					text = r.Text
					return Receipt{Status: StatusAccepted}, nil
				})
				if err != nil || result.Action != "wake" || !strings.Contains(text, "text of forced") || !strings.Contains(text, "text of quiet") {
					t.Fatalf("after the lease: %+v %v %q", result, err, text)
				}
			}
			if n, _ := PendingCount(env, "fiber"); n != 0 {
				t.Fatalf("pending = %d", n)
			}
		})
	}
}

// A held batch asks for a launch only while local records leave it
// unresolved and current: one whose pinned payload has a recorded confirmed
// receipt is closed delivered, and one whose thread result was superseded is
// dropped, each without a session or an emission. A current one still
// launches.
func TestAHeldBatchLaunchesOnlyWhileUnresolvedAndCurrent(t *testing.T) {
	for _, held := range []string{"confirmed", "superseded", "current"} {
		t.Run(held, func(t *testing.T) {
			env, w := consumeFixture(t)
			scripts := t.TempDir()
			calls := filepath.Join(scripts, "calls")
			current := map[bool]string{true: "true", false: "false"}[held != "superseded"]
			if err := os.WriteFile(filepath.Join(scripts, "shuttle"), []byte("#!/bin/sh\nprintf called >> '"+calls+"'\nprintf '{\"current\":"+current+"}\\n'\n"), 0700); err != nil {
				t.Fatal(err)
			}
			env.Set("PATH", scripts+string(os.PathListSeparator)+env.Getenv("PATH"))
			signal := &ThreadSignal{UID: "child", Verb: "closed", Owner: "host", Stamp: time.Now().UTC().Format(time.RFC3339Nano)}
			if err := Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: "thread-m", Text: "thread child closed: result", ThreadSignal: signal}, Wishes: Wishes{Turn: "ask"}}); err != nil {
				t.Fatal(err)
			}
			root := mailboxDir(env, "fiber", "fiber")
			items, _ := pendingItems(root)
			pinned := newConsumedAttempt(w, items, true)
			if err := pinConsumedBatch(root, &pinned); err != nil {
				t.Fatal(err)
			}
			if held == "confirmed" {
				// The transport confirmed the batch; the consumer died before closing it.
				req := *pinned.Payload
				req.Address = w.Address
				req.MessageID += "-" + mailboxKey(w.Address)[:16]
				path := filepath.Join(dataDir(env), "messages", mailboxKey(req.MessageID)+".json")
				if err := ensureDir(filepath.Dir(path), 0700); err != nil {
					t.Fatal(err)
				}
				bytes, _ := json.Marshal(record{Hash: requestHash(req), State: "complete", Receipt: Receipt{Status: StatusAccepted}})
				if err := mailboxWrite(path, bytes, false); err != nil {
					t.Fatal(err)
				}
			}
			transition(t, env, "", "-")
			result, err := consumeWith(context.Background(), env, "fiber", "host", dormant, neverSend(t))
			if err != nil {
				t.Fatal(err)
			}
			checked, _ := os.ReadFile(calls)
			switch held {
			case "current":
				if result.Action != "launch" || len(checked) == 0 {
					t.Fatalf("a current held batch: %+v, checked %q", result, checked)
				}
				return
			case "superseded":
				if len(checked) == 0 {
					t.Fatal("the held thread result's currency was not checked")
				}
			}
			if result.Action != "wait" {
				t.Fatalf("a %s held batch started a session: %+v", held, result)
			}
			if n, _ := PendingCount(env, "fiber"); n != 0 {
				t.Fatalf("pending = %d", n)
			}
			if manifests, _ := readBatchManifests(root); len(manifests) != 0 {
				t.Fatalf("the batch stayed open: %+v", manifests)
			}
			e := readEntry(t, filepath.Join(root, "offered", mailboxKey("thread-m")+".json"))
			if held == "confirmed" && (e.Attempt.Outcome != attemptDelivered || e.PossibleRepeat) {
				t.Fatalf("confirmed entry = %+v", e)
			}
		})
	}
}
