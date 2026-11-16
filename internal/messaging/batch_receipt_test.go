package messaging

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// writeJSON writes v as a store file the way an earlier build left it.
func writeJSON(t *testing.T, path string, v any) {
	t.Helper()
	if err := ensureDir(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0600); err != nil {
		t.Fatal(err)
	}
}

// A batch whose native receipt says the conversation queued it, when that
// conversation ends, rolls forward to the session launched in its place,
// marked as a possible repeat, and the fiber stops asking for launches.
func TestAQueuedBatchRollsForwardOnceItsConversationEnded(t *testing.T) {
	env, a := consumeFixture(t)
	a.Idle = true
	putWish(t, env, "m", "ask", "hold")
	queued := func(context.Context, *sysenv.Env, string, Request, string) (Receipt, error) {
		return Receipt{Status: StatusQueued, Transport: claudeNativeTransport}, nil
	}
	if result, _ := consumeWith(context.Background(), env, "fiber", "host", a, queued); result.Action != "wake" {
		t.Fatalf("first send: %+v", result)
	}
	// A's conversation ends; the fiber has no worker and launches one for m.
	if err := RegisterMailbox(env, "claude", "A", "host", "", os.Getpid(), false); err != nil {
		t.Fatal(err)
	}
	transition(t, env, "", "-")
	if result, err := consumeWith(context.Background(), env, "fiber", "host", dormant, neverSend(t)); err != nil || result.Action != "launch" {
		t.Fatalf("dormant: %+v %v", result, err)
	}
	if err := RegisterMailbox(env, "claude", "B", "host", t.TempDir(), os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	b := Worker{Address: "shuttle://host/claude/B", Epoch: transition(t, env, "B", "shuttle://host/claude/B"), Idle: true}
	var sent []string
	sender := func(_ context.Context, _ *sysenv.Env, _ string, r Request, address string) (Receipt, error) {
		if address == a.Address {
			return queued(context.Background(), env, "host", r, address)
		}
		sent = append(sent, r.Text)
		return Receipt{Status: StatusAccepted, Transport: claudeNativeTransport}, nil
	}
	if _, err := consumeWith(context.Background(), env, "fiber", "host", b, sender); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 1 || !strings.HasPrefix(sent[0], "Possible repeat:") || !strings.Contains(sent[0], "text of m") {
		t.Fatalf("B was sent %q", sent)
	}
	if n, _ := pendingCount(env, "fiber"); n != 0 {
		t.Fatalf("pending = %d", n)
	}
}

// The batch an earlier build pinned on the Mac, shaped as it is on disk: a
// quiet payload under its plain message id, pinned to a conversation that has
// ended and been replaced, its outcome in messages/ as a Claude hook queue's
// receipt, and its member carrying a copy of the attempt. The first consume of
// the current receiver closes it, and that receiver's hook offers the message
// marked as a possible repeat.
func TestAQuietBatchPinnedByAnEarlierBuildIsReleasedToTheCurrentReceiver(t *testing.T) {
	env := testEnv(t)
	const old, current = "shuttle://host/claude/A", "shuttle://host/claude/B"
	const id = "msg-0123456789abcdef0123456789abcdef"
	const text = "The night's digest changed; read it before the almanac."
	root := mailboxDir(env, "fiber", "fiber")
	if err := RegisterMailbox(env, "claude", "A", "host", "", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	if err := RegisterMailbox(env, "claude", "A", "host", "", os.Getpid(), false); err != nil {
		t.Fatal(err)
	}
	if err := RegisterMailbox(env, "claude", "B", "host", t.TempDir(), os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	b := Worker{Address: current, Epoch: transition(t, env, "B", current)}

	payload := map[string]any{"address": old, "text": text, "from": "shuttle://host/claude/sender", "reply_to": "proj/sender", "wake": false, "message_id": id}
	opened := time.Now().Add(-21 * time.Hour).UnixNano()
	attempt := map[string]any{"payload": payload, "base_text": text, "variant": "plain", "batch_id": batchID([]string{id}), "conversation": old, "members": []string{id}, "opened_at": opened}
	writeJSON(t, filepath.Join(root, "batches", batchID([]string{id})+".json"), attempt)
	writeJSON(t, filepath.Join(root, "pending", mailboxKey(id)+".json"), map[string]any{
		"request":         map[string]any{"address": "", "text": text, "from": "shuttle://host/claude/sender", "reply_to": "proj/sender", "wake": false, "message_id": id},
		"wishes":          map[string]any{"source": "message", "turn": "none", "session": "any", "if_costly": "hold"},
		"queued_at":       opened - int64(2*24*time.Hour),
		"attempt":         attempt,
		"attempt_address": old,
	})
	transport := id + "-" + mailboxKey(old)[:16]
	sent := Request{Address: old, Text: text, From: "shuttle://host/claude/sender", ReplyTo: "proj/sender", MessageID: transport}
	writeJSON(t, filepath.Join(dataDir(env), "messages", mailboxKey(transport)+".json"), map[string]any{
		"hash":    requestHash(sent),
		"state":   "complete",
		"receipt": map[string]any{"message_id": transport, "address": old, "status": "queued", "transport": "claude-hook", "detail": "queued for the session's next prompt or tool hook; no turn started"},
	})
	// The ended session's own hook took the queued copy.
	writeJSON(t, filepath.Join(mailboxDir(env, "claude", "A"), "offered", mailboxKey(transport)+".json"), map[string]any{"request": sent})

	if _, err := Consume(context.Background(), env, "fiber", "host", b); err != nil {
		t.Fatal(err)
	}
	if manifests, err := readBatchManifests(root); err != nil || len(manifests) != 0 {
		t.Fatalf("the batch stayed open: %+v %v", manifests, err)
	}
	var got []Request
	if err := OfferMailbox(env, "claude", "B", "host", func(batch []Request) error { got = append(got, batch...); return nil }); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].MessageID != id || !strings.HasPrefix(got[0].Text, "Possible repeat:") || !strings.HasSuffix(got[0].Text, text) {
		t.Fatalf("B's hook offered %+v", got)
	}
	if n, _ := pendingCount(env, "fiber"); n != 0 {
		t.Fatalf("pending = %d", n)
	}
}

// A consume never sends an open batch's payload again: a second pass over a
// batch whose receipt is unconfirmed reads its record instead.
func TestAnOpenBatchIsNotSentAgain(t *testing.T) {
	env, w := consumeFixture(t)
	w.Idle = true
	putWish(t, env, "m", "ask", "hold")
	calls := 0
	queued := func(context.Context, *sysenv.Env, string, Request, string) (Receipt, error) {
		calls++
		return Receipt{Status: StatusQueued, Transport: claudeNativeTransport}, nil
	}
	for i := 0; i < 3; i++ {
		if result, _ := consumeWith(context.Background(), env, "fiber", "host", w, queued); result.Action != "wake" {
			t.Fatalf("pass %d: %+v", i, result)
		}
	}
	if calls != 1 {
		t.Fatalf("the transport was called %d times for one open batch", calls)
	}
}

// Looking again at an open batch's Claude receipt reads the transcript to its
// end and stops: a consume over a stuck batch does not wait under the inbox
// lock.
func TestReobservingAnOpenBatchDoesNotWait(t *testing.T) {
	env, w := consumeFixture(t)
	putWish(t, env, "m", "ask", "hold")
	root := mailboxDir(env, "fiber", "fiber")
	transcript := filepath.Join(t.TempDir(), "A.jsonl")
	if err := os.WriteFile(transcript, nil, 0600); err != nil {
		t.Fatal(err)
	}
	writeJSON(t, filepath.Join(mailboxDir(env, "claude", "A"), "native.json"), map[string]any{"id": "A", "host": "host", "socket": filepath.Join(t.TempDir(), "absent.sock"), "transcript": transcript})
	payload := Request{Text: "text of m", Wake: true, MessageID: "batch-transport"}
	offset := int64(0)
	writeJSON(t, filepath.Join(root, "batches", batchID([]string{"m"})+".json"), map[string]any{
		"payload": payload, "base_text": payload.Text, "variant": "plain", "batch_id": batchID([]string{"m"}), "conversation": w.Address, "epoch": w.Epoch, "members": []string{"m"}, "opened_at": time.Now().UnixNano(),
		"receipt":           Receipt{MessageID: payload.MessageID, Address: w.Address, Status: StatusQueued, Transport: claudeNativeTransport},
		"transcript_offset": offset,
	})
	transport := payload.MessageID + "-" + mailboxKey(w.Address)[:16]
	sent := payload
	sent.Address, sent.MessageID = w.Address, transport
	writeJSON(t, filepath.Join(dataDir(env), "messages", mailboxKey(transport)+".json"), map[string]any{
		"hash": requestHash(sent), "state": "complete",
		"receipt":                   Receipt{MessageID: transport, Address: w.Address, Status: StatusQueued, Transport: claudeNativeTransport},
		"transcript_offset":         offset,
		"claude_queue_content_hash": nativeContentHash(Labeled(sent)),
	})
	start := time.Now()
	result, _ := Consume(context.Background(), env, "fiber", "host", w)
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("a consume over a queued batch took %v", elapsed)
	}
	if result.Action != "wake" {
		t.Fatalf("result = %+v", result)
	}
	if manifests, _ := readBatchManifests(root); len(manifests) != 1 {
		t.Fatalf("manifests = %+v", manifests)
	}
}

// A repeat of a message its fiber already delivered answers delivered even
// when the receiver's process is gone and the pass cannot decide.
func TestADeliveredMessageAnswersDeliveredWhenItsReceiverIsGone(t *testing.T) {
	env, w := consumeFixture(t)
	w.Idle = true
	putWish(t, env, "m", "ask", "hold")
	accepted := func(context.Context, *sysenv.Env, string, Request, string) (Receipt, error) {
		return Receipt{Status: StatusAccepted}, nil
	}
	if _, err := consumeWith(context.Background(), env, "fiber", "host", w, accepted); err != nil {
		t.Fatal(err)
	}
	if err := RegisterMailbox(env, "claude", "A", "host", "", os.Getpid(), false); err != nil {
		t.Fatal(err)
	}
	w.Message = "m"
	result, err := consumeWith(context.Background(), env, "fiber", "host", w, neverSend(t))
	if ErrorCode(err) != "unavailable" || result.Action != "wait" || result.Message != "delivered" {
		t.Fatalf("got %+v %v", result, err)
	}
	w.Message = "never-sent"
	if result, _ := consumeWith(context.Background(), env, "fiber", "host", w, neverSend(t)); result.Action != "" {
		t.Fatalf("an id that was never delivered answered %+v", result)
	}
}
