package messaging

import (
	"context"
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

// lapseLease moves every reservation's opening back past the lease.
func lapseLease(t *testing.T, env *sysenv.Env) {
	t.Helper()
	items, err := pendingItems(mailboxDir(env, "fiber", "fiber"))
	if err != nil {
		t.Fatal(err)
	}
	for _, it := range items {
		if it.entry.Attempt != nil {
			it.entry.Attempt.OpenedAt = time.Now().Add(-launchLease - time.Second).UnixNano()
			if err := writeMailboxEntry(it.path, it.entry); err != nil {
				t.Fatal(err)
			}
		}
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
				if result, err := consumeWith(context.Background(), env, "fiber", "host", dormant, neverSend(t)); err != nil || result.Action != "wait" {
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
	if result, err := consumeWith(context.Background(), env, "fiber", "host", dormant, neverSend(t)); err != nil || result.Action != "wait" {
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
	if e.Attempt == nil || e.Attempt.Outcome != attemptDelivered || e.Attempt.Conversation != "shuttle://host/claude/B" || e.Attempt.Launch {
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
	if e := readEntry(t, filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending", mailboxKey("forced")+".json")); e.Attempt != nil {
		t.Fatalf("an unaddressed worker reserved a launch: %+v", e.Attempt)
	}
	if _, err := consumeWith(context.Background(), env, "fiber", "host", Worker{Address: "-", Epoch: epoch + 1}, neverSend(t)); ErrorCode(err) != "stale_receiver" {
		t.Fatalf("a superseded epoch = %v", err)
	}
}
