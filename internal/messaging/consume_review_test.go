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

func TestReview1RejectedRetryPreservesOriginalAmbiguity(t *testing.T) {
	env := testEnv(t)
	r := Request{MessageID: "m", Text: "original", Wake: true}
	if err := Enqueue(env, InboxEntry{Address: "fiber", Request: r}); err != nil {
		t.Fatal(err)
	}
	a, b := "shuttle://host/codex/A", "shuttle://host/codex/B"
	transition(t, env, "A", a)
	path := filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending", mailboxKey("m")+".json")
	calls := 0
	var last Request
	sender := func(_ context.Context, _ *sysenv.Env, _ string, r Request, _ string) (Receipt, error) {
		calls++
		last = r
		if calls == 3 {
			return Receipt{Status: StatusRejected}, errCode("preflight_failed", "not sent")
		}
		return Receipt{Status: StatusUnknown}, errCode("ambiguous_delivery", "unknown")
	}
	_ = deliverFiberContextItemWith(context.Background(), env, "fiber", "host", a, r, sender)
	expireAttempt(t, path)
	_ = deliverFiberContextItemWith(context.Background(), env, "fiber", "host", a, r, sender)
	transition(t, env, "B", b)
	_ = deliverFiberContextItemWith(context.Background(), env, "fiber", "host", b, r, sender)
	if !strings.HasPrefix(last.Text, "Possible repeat:") {
		t.Fatalf("lost original ambiguity: %+v", last)
	}
}

func TestReview2ExhaustedRetryStillRollsToLiveSuccessor(t *testing.T) {
	env := testEnv(t)
	r := Request{MessageID: "m", Text: "original", Wake: true}
	if err := Enqueue(env, InboxEntry{Address: "fiber", Request: r}); err != nil {
		t.Fatal(err)
	}
	a, b := "shuttle://host/codex/A", "shuttle://host/codex/B"
	transition(t, env, "A", a)
	path := filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending", mailboxKey("m")+".json")
	var addresses []string
	sender := func(_ context.Context, _ *sysenv.Env, _ string, r Request, address string) (Receipt, error) {
		addresses = append(addresses, address)
		return Receipt{Status: StatusUnknown}, errCode("ambiguous_delivery", "unknown")
	}
	_ = deliverFiberContextItemWith(context.Background(), env, "fiber", "host", a, r, sender)
	expireAttempt(t, path)
	_ = deliverFiberContextItemWith(context.Background(), env, "fiber", "host", a, r, sender)
	expireAttempt(t, path)
	transition(t, env, "B", b)
	_ = deliverFiberContextItemWith(context.Background(), env, "fiber", "host", b, r, sender)
	if addresses[len(addresses)-1] != b {
		t.Fatalf("stuck at exhausted predecessor: %v", addresses)
	}
}

func TestReview5LegacyCaveatVariantSurvivesValidationRecovery(t *testing.T) {
	for _, payloadStored := range []bool{false, true} {
		t.Run(map[bool]string{false: "receipt reconstruction", true: "frozen payload"}[payloadStored], func(t *testing.T) {
			env := testEnv(t)
			r := Request{MessageID: "thread-result", Text: "thread child closed: original", Wake: true}
			if err := Enqueue(env, InboxEntry{Address: "fiber", Request: r}); err != nil {
				t.Fatal(err)
			}
			address := "shuttle://host/codex/A"
			transition(t, env, "A", address)
			path := filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending", mailboxKey(r.MessageID)+".json")
			if _, err := claimBatch([]string{path}, address, true); err != nil {
				t.Fatal(err)
			}
			calls := 0
			sender := func(ctx context.Context, env *sysenv.Env, _ string, r Request, address string) (Receipt, error) {
				r.Address = address
				r.MessageID += "-" + mailboxKey(address)[:16]
				return withDedup(ctx, env, r, func(context.Context) dedupSendResult {
					calls++
					return dedupSendResult{Receipt: Receipt{Status: StatusUnknown}, Err: errCode("ambiguous_delivery", "unknown")}
				})
			}
			caveat := r
			caveat.Text = withStalenessCaveat(r.Text)
			if payloadStored {
				_ = deliverFiberContextItemWith(context.Background(), env, "fiber", "host", address, caveat, sender)
			} else {
				_, _ = sender(context.Background(), env, "host", caveat, address)
			}
			err := deliverFiberContextItemWith(context.Background(), env, "fiber", "host", address, r, sender)
			if ErrorCode(err) != "ambiguous_delivery" || calls != 1 {
				t.Fatalf("variant changed after upgrade: calls=%d err=%v", calls, err)
			}
			e := readEntry(t, path)
			if e.Attempt.Payload == nil || !strings.HasPrefix(e.Attempt.Payload.Text, staleThreadSignalCaveat) {
				t.Fatalf("caveat not pinned: %+v", e.Attempt)
			}
		})
	}
}

func TestReview7And8BatchTransportIDsAndRetryBounds(t *testing.T) {
	env, w := consumeFixture(t)
	w.Idle = true
	id := strings.Repeat("m", 239)
	if err := Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: id, Text: strings.Repeat("x", 65536)}, Wishes: Wishes{Turn: "ask"}}); err != nil {
		t.Fatal(err)
	}
	seen := map[string]string{}
	sender := func(_ context.Context, _ *sysenv.Env, _ string, r Request, address string) (Receipt, error) {
		r.Address = address
		r.MessageID += "-" + mailboxKey(address)[:16]
		if err := validateRequest("host", r); err != nil {
			t.Fatalf("invalid internal framing: %v", err)
		}
		if old, ok := seen[r.MessageID]; ok && old != r.Text {
			t.Fatal("transport id collision")
		}
		seen[r.MessageID] = r.Text
		return Receipt{Status: StatusUnknown}, errCode("ambiguous_delivery", "unknown")
	}
	_, _ = consumeWith(context.Background(), env, "fiber", "host", w, sender)
	root := mailboxDir(env, "fiber", "fiber")
	a, _ := readConsumedBatch(root)
	a.OpenedAt = time.Now().Add(-liveAttemptRetryAfter).UnixNano()
	_ = pinConsumedBatch(root, &a)
	_, _ = consumeWith(context.Background(), env, "fiber", "host", w, sender)
	if len(seen) != 2 {
		t.Fatalf("variants=%v", seen)
	}
	members := []string{"m"}
	plain := batchTransportID([]string{"m-retry-1"}, w.Address, "plain", "text")
	retry := batchTransportID(members, w.Address, "retry-1", "text")
	if plain == retry || len(retry) > 80 {
		t.Fatalf("unbounded or colliding ids: %q %q", plain, retry)
	}
}

func TestConsumeNewCaveatPayloadIsFrozen(t *testing.T) {
	env, w := consumeFixture(t)
	w.Idle = true
	scripts := t.TempDir()
	script := filepath.Join(scripts, "shuttle")
	write := func(body string) {
		t.Helper()
		if err := os.WriteFile(script, []byte("#!/bin/sh\n"+body), 0700); err != nil {
			t.Fatal(err)
		}
	}
	write("echo 'unknown command thread-signal-current' >&2; exit 1\n")
	env.Set("PATH", scripts+string(os.PathListSeparator)+env.Getenv("PATH"))
	signal := &ThreadSignal{UID: "child", Verb: "closed", Owner: "host", Stamp: time.Now().UTC().Format(time.RFC3339Nano)}
	if err := Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: "thread-m", Text: "thread child closed: result", ThreadSignal: signal}, Wishes: Wishes{Turn: "ask"}}); err != nil {
		t.Fatal(err)
	}
	var payloads []Request
	sender := func(_ context.Context, _ *sysenv.Env, _ string, r Request, _ string) (Receipt, error) {
		payloads = append(payloads, r)
		return Receipt{Status: StatusUnknown}, errCode("ambiguous_delivery", "unknown")
	}
	_, _ = consumeWith(context.Background(), env, "fiber", "host", w, sender)
	write("printf '{\"current\":true}\\n'\n")
	// Validation backoff belongs to this isolated data dir.
	if err := os.RemoveAll(filepath.Join(dataDir(env), "thread-validation")); err != nil {
		t.Fatal(err)
	}
	_, _ = consumeWith(context.Background(), env, "fiber", "host", w, sender)
	if len(payloads) != 2 || payloads[0].Text != payloads[1].Text || payloads[0].MessageID != payloads[1].MessageID || !strings.Contains(payloads[0].Text, staleThreadSignalCaveat) {
		bytes, _ := json.Marshal(payloads)
		t.Fatalf("variant changed: %s", bytes)
	}
}
