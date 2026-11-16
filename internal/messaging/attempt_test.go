package messaging

import (
	"context"
	"encoding/json"
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

func TestClaimAfterCrashReturnsTheSameBatch(t *testing.T) {
	const a, b = "shuttle://host/claude/A", "shuttle://host/claude/B"
	env := testEnv(t)
	paths := enqueueFiber(t, env, "first", "second")
	epoch := transition(t, env, "execution-A", a)

	first, err := claimBatch(paths, a)
	if err != nil {
		t.Fatal(err)
	}
	if first.Conversation != a || first.Epoch != epoch || first.Outcome != "" || first.OpenedAt == 0 || fmt.Sprint(first.Members) != "[first second]" || first.BatchID != batchID([]string{"second", "first"}) {
		t.Fatalf("claimed attempt = %+v (epoch %d)", first, epoch)
	}
	// The process dies here: the attempt is never closed.
	for _, path := range paths {
		entry := readEntry(t, path)
		if !entry.Attempt.open() || entry.Attempt.BatchID != first.BatchID || entry.AttemptAddress != "" {
			t.Fatalf("after the crash, %s holds %+v at %q", path, entry.Attempt, entry.AttemptAddress)
		}
	}

	again, err := claimBatch([]string{paths[1], paths[0]}, a)
	if err != nil {
		t.Fatal(err)
	}
	if again.BatchID != first.BatchID || again.OpenedAt != first.OpenedAt || fmt.Sprint(again.Members) != fmt.Sprint(first.Members) {
		t.Fatalf("reclaim for the same conversation = %+v, want the open attempt %+v", again, first)
	}

	other, err := claimBatch(paths, b)
	if err != nil {
		t.Fatal(err)
	}
	if other.Conversation != b || other.Epoch != 0 || other.BatchID != first.BatchID {
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
	entry := readEntry(t, paths[0])
	if !entry.Attempt.open() || entry.Attempt.Conversation != a || entry.AttemptAddress != "" {
		t.Fatalf("after a failed emit, entry = %+v", entry)
	}
	if !fiberContextHookEligible(root, a, entry.Request) {
		t.Fatal("an unpinned hook attempt kept the entry from the next hook")
	}
	var got []string
	if err := offerMailboxWithAck(root, a, func(Request) bool { return true }, func(batch []Request) error {
		for _, r := range batch {
			got = append(got, r.MessageID)
		}
		return nil
	}, nil, "claude"); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(got) != "[only]" {
		t.Fatalf("next hook offered %v", got)
	}
	offered := readEntry(t, filepath.Join(root, "offered", filepath.Base(paths[0])))
	if offered.Attempt == nil || offered.Attempt.Outcome != attemptDelivered || offered.Attempt.BatchID != entry.Attempt.BatchID {
		t.Fatalf("offered entry's attempt = %+v", offered.Attempt)
	}
}

// TestRacedReadersDeliverAnEntryOnceWithADeliveredAttempt races the hook
// offer against the consumer's wake. The inbox lock keeps the loser from
// reading pending/; the claim makes the entry reach offered/ with a delivered
// attempt whichever reader took it.
func TestRacedReadersDeliverAnEntryOnceWithADeliveredAttempt(t *testing.T) {
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
		if offered.Attempt == nil || offered.Attempt.Outcome != attemptDelivered {
			t.Fatalf("round %d: offered attempt = %+v", round, offered.Attempt)
		}
	}
}

// mainEntry is the entry as origin/main (b70f2e61b) decodes it: no attempt
// record, and no custom decoding.
type mainEntry struct {
	Request        Request         `json:"request"`
	Wishes         Wishes          `json:"wishes"`
	QueuedAt       int64           `json:"queued_at"`
	Fallback       *claudeFallback `json:"fallback,omitempty"`
	AttemptAddress string          `json:"attempt_address,omitempty"`
	PossibleRepeat bool            `json:"possible_repeat,omitempty"`
}

func TestEntriesThisBuildWritesReadTheSameToAnOlderBuild(t *testing.T) {
	const a = "shuttle://host/claude/A"
	for _, tc := range []struct {
		name        string
		act         func([]string) error
		wantPin     string
		wantRepeat  bool
		wantPending bool
	}{
		{"direct claim", func(p []string) error { pinBatch(t, p, a); return nil }, a, false, true},
		{"hook claim", func(p []string) error { _, err := claimBatch(p, a); return err }, "", false, true},
		{"released", func(p []string) error {
			pinBatch(t, p, a)
			return closeAttempts(p, attemptReleased)
		}, "", false, true},
		{"ambiguous", func(p []string) error {
			pinBatch(t, p, a)
			return closeAttempts(p, attemptAmbiguous)
		}, "", true, true},
		{"delivered", func(p []string) error {
			pinBatch(t, p, a)
			return closeAttempts(p, attemptDelivered)
		}, a, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := testEnv(t)
			paths := enqueueFiber(t, env, "m")
			if err := tc.act(paths); err != nil {
				t.Fatal(err)
			}
			path := paths[0]
			if !tc.wantPending {
				path = filepath.Join(filepath.Dir(filepath.Dir(path)), "offered", filepath.Base(path))
			}
			b, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("entry not where an older build looks for it: %v", err)
			}
			var old mainEntry
			if err := json.Unmarshal(b, &old); err != nil {
				t.Fatal(err)
			}
			if old.AttemptAddress != tc.wantPin || old.PossibleRepeat != tc.wantRepeat || old.Request.MessageID != "m" || old.Request.Text != "text of m" {
				t.Fatalf("an older build reads %+v", old)
			}
		})
	}
}

func TestUnknownRolloverClosesAndReclaimsInOneEntry(t *testing.T) {
	env := testEnv(t)
	path := enqueueFiber(t, env, "rolled")[0]
	const first, next = "shuttle://host/claude/A", "shuttle://host/claude/B"
	pinBatch(t, []string{path}, first)
	for _, active := range []bool{true, false} {
		if err := RegisterMailbox(env, "claude", "A", "host", "/project", os.Getpid(), active); err != nil {
			t.Fatal(err)
		}
	}
	epoch := transition(t, env, "execution-B", next)
	sender := func(_ context.Context, _ *sysenv.Env, _ string, _ Request, address string) (Receipt, error) {
		if address == first {
			return Receipt{Status: StatusUnknown}, errCode("ambiguous_delivery", "lost reply")
		}
		return Receipt{Status: StatusUnknown}, errCode("ambiguous_delivery", "lost again")
	}
	_ = deliverBatch(t, env, next, Request{MessageID: "rolled", Text: "text of rolled"}, sender)
	entry := readEntry(t, path)
	if entry.AttemptAddress != next || !entry.PossibleRepeat || !entry.Attempt.open() || entry.Attempt.Conversation != next || entry.Attempt.Epoch != epoch {
		t.Fatalf("after rolling forward, entry = %+v, attempt %+v", entry, entry.Attempt)
	}
}

func TestPendingEntriesShowAnOpenAttempt(t *testing.T) {
	env := testEnv(t)
	path := enqueueFiber(t, env, "m")[0]
	pinBatch(t, []string{path}, "shuttle://host/claude/A")
	entries, err := PendingEntries(env, "fiber")
	if err != nil || len(entries) != 1 || entries[0].Attempt == nil || entries[0].Attempt.Conversation != "shuttle://host/claude/A" {
		t.Fatalf("pending = %+v, %v", entries, err)
	}
	if err := closeAttempts([]string{path}, attemptReleased); err != nil {
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
			pinBatch(t, []string{path}, a)
			if err := os.Chtimes(path, old, old); err != nil {
				t.Fatal(err)
			}
			if err := closeAttempts([]string{path}, attemptDelivered); err != nil {
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
	sender := func(ctx context.Context, env *sysenv.Env, host string, req Request, address string) (Receipt, error) {
		req.Address = address
		req.MessageID += "-" + mailboxKey(address)[:16]
		return withDedup(ctx, env, req, func(context.Context) dedupSendResult {
			sent = append(sent, req)
			if !strings.HasPrefix(req.Text, "Possible repeat:") {
				return dedupSendResult{Receipt: Receipt{Status: StatusUnknown, Transport: "codex-terminal"}, Err: errCode("ambiguous_delivery", "paste outcome unknown")}
			}
			return dedupSendResult{Receipt: Receipt{MessageID: req.MessageID, Status: StatusSubmitted, Transport: "codex-terminal"}}
		})
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
	entry := readEntry(t, path)
	if !entry.Attempt.open() || entry.AttemptAddress != a {
		t.Fatalf("within the bound, entry = %+v", entry)
	}
	expireAttempt(t, path)
	if err := deliver(); err != nil {
		t.Fatalf("retry = %v", err)
	}
	if len(sent) != 2 || sent[1].MessageID == sent[0].MessageID || !strings.HasPrefix(sent[1].Text, "Possible repeat:") {
		t.Fatalf("sends = %+v", sent)
	}
	entry = readEntry(t, filepath.Join(root, "offered", filepath.Base(path)))
	if entry.Attempt.Outcome != attemptDelivered || entry.Attempt.Retry != 1 || entry.PossibleRepeat {
		t.Fatalf("after the retry, entry = %+v attempt %+v", entry, entry.Attempt)
	}
}

// dedupSender sends through the dedup layer under direct delivery's
// per-address transport id, with outcome deciding each new send.
func dedupSender(sent *[]Request, outcome func(Request) (string, string)) func(context.Context, *sysenv.Env, string, Request, string) (Receipt, error) {
	return func(ctx context.Context, env *sysenv.Env, host string, req Request, address string) (Receipt, error) {
		req.Address = address
		req.MessageID += "-" + mailboxKey(address)[:16]
		return withDedup(ctx, env, req, func(context.Context) dedupSendResult {
			*sent = append(*sent, req)
			status, code := outcome(req)
			result := dedupSendResult{Receipt: Receipt{MessageID: req.MessageID, Status: status, Transport: "codex-terminal"}}
			if code != "" {
				result.Err = errCode(code, "%s", code)
			}
			return result
		})
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
	sender := dedupSender(&sent, func(Request) (string, string) {
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
	if entry := readEntry(t, path); entry.Attempt.Retry != 0 {
		t.Fatalf("attempt = %+v", entry.Attempt)
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
	entry := readEntry(t, path)
	if len(ids) != 2 || !entry.Attempt.open() || entry.Attempt.Retry != 1 || entry.AttemptAddress != a {
		t.Fatalf("transport ids %v, entry = %+v attempt %+v", ids, entry, entry.Attempt)
	}
}
