package messaging

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// enqueueFiber puts entries in the test fiber's inbox and returns their
// pending paths, oldest first.
func enqueueFiber(t *testing.T, env *sysenv.Env, ids ...string) []string {
	t.Helper()
	root := mailboxDir(env, "fiber", "fiber")
	paths := make([]string, len(ids))
	for i, id := range ids {
		if err := Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: id, Text: "text of " + id}}); err != nil {
			t.Fatal(err)
		}
		paths[i] = filepath.Join(root, "pending", mailboxKey(id)+".json")
	}
	return paths
}

func readEntry(t *testing.T, path string) mailboxEntry {
	t.Helper()
	entry, err := readFiberMailboxEntry(path)
	if err != nil {
		t.Fatal(err)
	}
	return entry
}

func TestAHookClaimIsAManifestAndLeavesItsMembersAsTheyWere(t *testing.T) {
	const a, b = "shuttle://host/claude/A", "shuttle://host/claude/B"
	env := testEnv(t)
	root := mailboxDir(env, "fiber", "fiber")
	paths := enqueueFiber(t, env, "first", "second")
	epoch := transition(t, env, "execution-A", a)
	before := make([][]byte, len(paths))
	items := make([]mailboxPendingItem, len(paths))
	for i, path := range paths {
		before[i], _ = os.ReadFile(path)
		items[i] = mailboxPendingItem{path, readEntry(t, path)}
	}

	claim, err := claimBatch(root, items, a)
	if err != nil {
		t.Fatal(err)
	}
	stored := batchOf(t, root, "first")
	if stored == nil || !stored.Hook || stored.Payload != nil || stored.Conversation != a || stored.Epoch != epoch || stored.Outcome != "" || stored.OpenedAt == 0 || fmt.Sprint(stored.Members) != "[first second]" || stored.BatchID != batchID([]string{"second", "first"}) || stored.BatchID != claim.BatchID {
		t.Fatalf("claim manifest = %+v (epoch %d)", stored, epoch)
	}
	for i, path := range paths {
		if after, _ := os.ReadFile(path); string(after) != string(before[i]) {
			t.Fatalf("the claim rewrote %s: %s", path, after)
		}
	}
	if err := closeBatch(root, &claim, attemptAmbiguous); err != nil {
		t.Fatal(err)
	}
	other, err := claimBatch(root, items, b)
	if err != nil {
		t.Fatal(err)
	}
	if other.Conversation != b || other.Epoch != 0 || other.BatchID != claim.BatchID {
		t.Fatalf("claim for a conversation that is not the receiver = %+v", other)
	}
}

func TestHookThatDiesAfterItsClaimLeavesTheEntryOfferable(t *testing.T) {
	env := testEnv(t)
	paths := enqueueFiber(t, env, "only")
	root := mailboxDir(env, "fiber", "fiber")
	const a = "shuttle://host/claude/A"
	lost := errors.New("hook output lost")
	if err := offerMailboxWithAck(root, a, func(Request) bool { return true }, func([]Request) error { return lost }, nil, "claude"); !errors.Is(err, lost) {
		t.Fatalf("offer = %v", err)
	}
	claim := batchOf(t, root, "only")
	if claim == nil || !claim.Hook || claim.Conversation != a || readEntry(t, paths[0]).PossibleRepeat {
		t.Fatalf("after a failed emit, claim = %+v", claim)
	}
	var got []Request
	if err := offerMailboxWithAck(root, a, func(Request) bool { return true }, func(batch []Request) error {
		got = append(got, batch...)
		return nil
	}, nil, "claude"); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].MessageID != "only" || !strings.HasPrefix(got[0].Text, hookRepeatWarning) {
		t.Fatalf("next hook offered %+v", got)
	}
	offered := readEntry(t, filepath.Join(root, "offered", filepath.Base(paths[0])))
	if offered.Disposition != "" || !offered.PossibleRepeat || batchOf(t, root, "only") != nil {
		t.Fatalf("offered entry = %+v", offered)
	}
}

// TestRacedReadersDeliverAnEntryOnce races the hook offer against the
// consumer's wake. The inbox lock keeps the loser from reading pending/; the
// entry reaches offered/ as delivered, with its batch closed, whichever reader
// took it.
func TestRacedReadersDeliverAnEntryOnce(t *testing.T) {
	env, w := consumeFixture(t)
	w.Idle = true
	root := mailboxDir(env, "fiber", "fiber")
	for round := 0; round < 40; round++ {
		id := fmt.Sprintf("raced-%d", round)
		putWish(t, env, id, "ask", "hold")
		path := filepath.Join(root, "pending", mailboxKey(id)+".json")
		var takes atomic.Int32
		sender := func(context.Context, *sysenv.Env, string, Request, string) (Receipt, error) {
			takes.Add(1)
			return Receipt{Status: StatusAccepted}, nil
		}
		start := make(chan struct{})
		var wg sync.WaitGroup
		errs := make([]error, 2)
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			errs[0] = offerMailboxWithAck(root, w.Address, func(r Request) bool { return fiberContextHookEligible(root, w.Address, r) }, func(batch []Request) error {
				takes.Add(int32(len(batch)))
				return nil
			}, nil, "claude")
		}()
		go func() {
			defer wg.Done()
			<-start
			_, errs[1] = consumeWith(context.Background(), env, "fiber", "host", w, sender)
		}()
		close(start)
		wg.Wait()
		if err := errors.Join(errs...); err != nil {
			t.Fatal(err)
		}
		if n := takes.Load(); n != 1 {
			t.Fatalf("round %d: the entry was taken %d times", round, n)
		}
		if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("round %d: entry still pending (%v)", round, err)
		}
		offered := readEntry(t, filepath.Join(root, "offered", filepath.Base(path)))
		if offered.Disposition != "" || batchOf(t, root, id) != nil {
			t.Fatalf("round %d: offered entry = %+v", round, offered)
		}
	}
}

func TestABatchClosesByItsOutcome(t *testing.T) {
	const a = "shuttle://host/claude/A"
	for _, tc := range []struct {
		outcome, variant string
		wantRepeat       bool
		wantPending      bool
	}{
		{attemptReleased, "plain", false, true},
		{attemptReleased, "possible-repeat", true, true},
		{attemptReleased, "retry-1", true, true},
		{attemptAmbiguous, "plain", true, true},
		{attemptDelivered, "plain", false, false},
	} {
		t.Run(tc.outcome+"/"+tc.variant, func(t *testing.T) {
			env := testEnv(t)
			root := mailboxDir(env, "fiber", "fiber")
			path := enqueueFiber(t, env, "m")[0]
			batch := pinBatch(t, []string{path}, a)
			batch.Variant = tc.variant
			if err := closeBatch(root, &batch, tc.outcome); err != nil {
				t.Fatal(err)
			}
			if !tc.wantPending {
				path = filepath.Join(root, "offered", filepath.Base(path))
			}
			entry := readEntry(t, path)
			if entry.PossibleRepeat != tc.wantRepeat || entry.Disposition != "" || batchOf(t, root, "m") != nil {
				t.Fatalf("after closing %s, entry = %+v", tc.outcome, entry)
			}
		})
	}
}

func TestUnknownRolloverClosesAndReclaimsInOneEntry(t *testing.T) {
	env := testEnv(t)
	if err := Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: "rolled", Text: "text of rolled"}, Wishes: Wishes{Turn: "force"}}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending", mailboxKey("rolled")+".json")
	const first, next = "shuttle://host/claude/A", "shuttle://host/claude/B"
	pinBatch(t, []string{path}, first)
	for _, active := range []bool{true, false} {
		if err := RegisterMailbox(env, "claude", "A", "host", "/project", os.Getpid(), active); err != nil {
			t.Fatal(err)
		}
	}
	epoch := transition(t, env, "execution-B", next)
	var sent []string
	sender := func(_ context.Context, _ *sysenv.Env, _ string, r Request, address string) (Receipt, error) {
		if address == first {
			t.Fatal("a pinned send was sent again")
		}
		sent = append(sent, r.Text)
		return Receipt{Status: StatusUnknown}, errCode("ambiguous_delivery", "lost again")
	}
	_ = deliverBatch(t, env, next, Request{MessageID: "rolled", Text: "text of rolled"}, sender)
	batch := batchOf(t, filepath.Dir(filepath.Dir(path)), "rolled")
	if len(sent) != 1 || !strings.HasPrefix(sent[0], "Possible repeat:") || batch == nil || batch.Conversation != next || batch.Epoch != epoch || batch.Variant != "possible-repeat" || batch.Outcome != "" {
		t.Fatalf("after rolling forward, sent %q, batch %+v", sent, batch)
	}
}

func TestPendingEntriesShowAnOpenAttempt(t *testing.T) {
	env := testEnv(t)
	path := enqueueFiber(t, env, "m")[0]
	batch := pinBatch(t, []string{path}, "shuttle://host/claude/A")
	entries, err := PendingEntries(env, "fiber")
	if err != nil || len(entries) != 1 || entries[0].Attempt == nil || entries[0].Attempt.Conversation != "shuttle://host/claude/A" {
		t.Fatalf("pending = %+v, %v", entries, err)
	}
	if err := closeBatch(mailboxDir(env, "fiber", "fiber"), &batch, attemptReleased); err != nil {
		t.Fatal(err)
	}
	entries, err = PendingEntries(env, "fiber")
	if err != nil || len(entries) != 1 || entries[0].Attempt != nil {
		t.Fatalf("after release, pending = %+v, %v", entries, err)
	}
}

func TestDeliveredEntryKeepsTheModificationTimeRetentionRunsFrom(t *testing.T) {
	const a = "shuttle://host/claude/A"
	old := time.Now().Add(-10 * 24 * time.Hour).Truncate(time.Second)
	for _, tc := range []struct {
		name    string
		deliver func(t *testing.T, env *sysenv.Env, root, path string)
	}{
		{"hook offer keeps the enqueue time", func(t *testing.T, env *sysenv.Env, root, path string) {
			if err := os.Chtimes(path, old, old); err != nil {
				t.Fatal(err)
			}
			if err := offerMailboxWithAck(root, a, func(Request) bool { return true }, func([]Request) error { return nil }, nil, "claude"); err != nil {
				t.Fatal(err)
			}
		}},
		{"direct delivery keeps the claim time", func(t *testing.T, env *sysenv.Env, root, path string) {
			batch := pinBatch(t, []string{path}, a)
			if err := os.Chtimes(path, old, old); err != nil {
				t.Fatal(err)
			}
			if err := closeBatch(root, &batch, attemptDelivered); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := testEnv(t)
			root := mailboxDir(env, "fiber", "fiber")
			transition(t, env, "execution-A", a)
			path := enqueueFiber(t, env, "aged")[0]
			tc.deliver(t, env, root, path)
			info, err := os.Stat(filepath.Join(root, "offered", filepath.Base(path)))
			if err != nil {
				t.Fatal(err)
			}
			if !info.ModTime().Equal(old) {
				t.Fatalf("offered entry's mtime = %v, want %v", info.ModTime(), old)
			}
		})
	}
}

func TestAmbiguousWakeToALiveReceiverIsRetriedAfterTheBound(t *testing.T) {
	const a = "shuttle://host/codex/A"
	env := testEnv(t)
	root := mailboxDir(env, "fiber", "fiber")
	request := Request{MessageID: "wake-ambiguous", Text: "please continue", Wake: true}
	if err := Enqueue(env, InboxEntry{Address: "fiber", Request: request}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "pending", mailboxKey(request.MessageID)+".json")
	var sent []Request
	sender := func(_ context.Context, _ *sysenv.Env, _ string, req Request, _ string) (Receipt, error) {
		sent = append(sent, req)
		if !strings.HasPrefix(req.Text, "Possible repeat:") {
			return Receipt{Status: StatusUnknown, Transport: "codex-terminal"}, errCode("ambiguous_delivery", "paste outcome unknown")
		}
		return Receipt{MessageID: req.MessageID, Status: StatusSubmitted, Transport: "codex-terminal"}, nil
	}
	deliver := func() error {
		return deliverBatch(t, env, a, request, sender)
	}
	for i := 0; i < 2; i++ {
		if err := deliver(); ErrorCode(err) != "ambiguous_delivery" {
			t.Fatalf("delivery %d = %v, want ambiguous_delivery", i, err)
		}
	}
	if len(sent) != 1 {
		t.Fatalf("within the bound the transport saw %d sends, want 1", len(sent))
	}
	if batch := batchOf(t, root, request.MessageID); batch == nil || batch.Conversation != a || batch.status() != StatusUnknown {
		t.Fatalf("within the bound, batch = %+v", batch)
	}
	expireAttempt(t, path)
	if err := deliver(); err != nil {
		t.Fatalf("retry = %v", err)
	}
	if len(sent) != 2 || sent[1].MessageID == sent[0].MessageID || !strings.HasPrefix(sent[1].Text, "Possible repeat: an earlier delivery of this message to this session") {
		t.Fatalf("sends = %+v", sent)
	}
	entry := readEntry(t, filepath.Join(root, "offered", filepath.Base(path)))
	if entry.Disposition != "" || entry.PossibleRepeat || batchOf(t, root, request.MessageID) != nil {
		t.Fatalf("after the retry, entry = %+v", entry)
	}
}

// outcomeSender records each send, with outcome deciding its receipt.
func outcomeSender(sent *[]Request, outcome func(Request) (string, string)) fiberContextSender {
	return func(_ context.Context, _ *sysenv.Env, _ string, req Request, address string) (Receipt, error) {
		req.Address = address
		*sent = append(*sent, req)
		status, code := outcome(req)
		receipt := Receipt{MessageID: req.MessageID, Status: status, Transport: "codex-terminal"}
		if code != "" {
			return receipt, errCode(code, "%s", code)
		}
		return receipt, nil
	}
}

func TestARejectedRetryIsSentAgainAsAPossibleRepeat(t *testing.T) {
	const a = "shuttle://host/codex/A"
	env := testEnv(t)
	request := Request{MessageID: "wake-retry-rejected", Text: "continue", Wake: true}
	if err := Enqueue(env, InboxEntry{Address: "fiber", Request: request}); err != nil {
		t.Fatal(err)
	}
	epoch := transition(t, env, "A", a)
	path := filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending", mailboxKey(request.MessageID)+".json")
	var sent []Request
	outcomes := []struct{ status, code string }{{StatusUnknown, "ambiguous_delivery"}, {StatusRejected, "preflight_failed"}, {StatusSubmitted, ""}}
	sender := outcomeSender(&sent, func(Request) (string, string) {
		o := outcomes[len(sent)-1]
		return o.status, o.code
	})
	deliver := func() error {
		return deliverBatch(t, env, a, request, sender)
	}
	if err := deliver(); ErrorCode(err) != "ambiguous_delivery" {
		t.Fatalf("first = %v", err)
	}
	expireAttempt(t, path)
	if err := deliver(); ErrorCode(err) != "preflight_failed" {
		t.Fatalf("rejected retry = %v", err)
	}
	// The rejection released the entry; the next batch warns of the earlier
	// unknown outcome under its own transport id.
	if result, err := consumeWith(context.Background(), env, "fiber", "host", Worker{Address: a, Epoch: epoch, Idle: true}, sender); err != nil || result.Action != "wake" {
		t.Fatalf("consume after the rejection = %+v, %v", result, err)
	}
	if len(sent) != 3 || sent[2].MessageID == sent[1].MessageID || sent[0].MessageID == sent[1].MessageID || !strings.HasPrefix(sent[2].Text, "Possible repeat: an earlier delivery of this message had an unknown outcome.") {
		t.Fatalf("sends = %+v", sent)
	}
}

func TestAHeldApprovalIsNotRetried(t *testing.T) {
	const a = "shuttle://host/claude/A"
	env := testEnv(t)
	request := Request{MessageID: "wake-held", Text: "continue", Wake: true}
	if err := Enqueue(env, InboxEntry{Address: "fiber", Request: request}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending", mailboxKey(request.MessageID)+".json")
	calls := 0
	sender := func(context.Context, *sysenv.Env, string, Request, string) (Receipt, error) {
		calls++
		return Receipt{Status: StatusUnknown}, errCode("wake_held", "receiver approval is required")
	}
	for i := 0; i < 2; i++ {
		if err := deliverBatch(t, env, a, request, sender); ErrorCode(err) != "wake_held" {
			t.Fatal(err)
		}
		expireAttempt(t, path)
	}
	if batch := batchOf(t, filepath.Dir(filepath.Dir(path)), request.MessageID); calls != 1 || batch == nil || batch.Retry != 0 || batch.ErrorCode != "wake_held" {
		t.Fatalf("calls %d, batch = %+v", calls, batch)
	}
}

func TestALiveConversationGetsOneRetry(t *testing.T) {
	const a = "shuttle://host/codex/A"
	env := testEnv(t)
	request := Request{MessageID: "wake-always-unknown", Text: "continue", Wake: true}
	if err := Enqueue(env, InboxEntry{Address: "fiber", Request: request}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending", mailboxKey(request.MessageID)+".json")
	ids := map[string]bool{}
	sender := func(_ context.Context, _ *sysenv.Env, _ string, req Request, _ string) (Receipt, error) {
		ids[req.MessageID] = true
		return Receipt{Status: StatusUnknown}, errCode("ambiguous_delivery", "lost reply")
	}
	for i := 0; i < 4; i++ {
		if err := deliverBatch(t, env, a, request, sender); ErrorCode(err) != "ambiguous_delivery" {
			t.Fatalf("delivery %d = %v", i, err)
		}
		expireAttempt(t, path)
	}
	batch := batchOf(t, filepath.Dir(filepath.Dir(path)), request.MessageID)
	if len(ids) != 2 || batch == nil || batch.Retry != 1 || batch.Conversation != a {
		t.Fatalf("transport ids %v, batch = %+v", ids, batch)
	}
}
