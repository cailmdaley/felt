package messaging

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

func consumeFixture(t *testing.T) (*sysenv.Env, Worker) {
	t.Helper()
	env := testEnv(t)
	if err := RegisterMailbox(env, "claude", "A", "host", t.TempDir(), os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	return env, Worker{Address: "shuttle://host/claude/A", Epoch: transition(t, env, "A", "shuttle://host/claude/A")}
}
func putWish(t *testing.T, env *sysenv.Env, id, turn, cost string) {
	t.Helper()
	if err := Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: id, Text: "text of " + id}, Wishes: Wishes{Turn: turn, IfCostly: cost}}); err != nil {
		t.Fatal(err)
	}
}
func TestConsumeRule(t *testing.T) {
	for _, turn := range []string{"none", "ask", "idle", "force"} {
		for _, cost := range []string{"hold", "fresh"} {
			for _, state := range []string{"busy", "idle", "costly"} {
				t.Run(turn+"/"+cost+"/"+state, func(t *testing.T) {
					env, w := consumeFixture(t)
					w.Idle = state != "busy"
					w.Costly = state == "costly"
					putWish(t, env, "m", turn, cost)
					sends := 0
					sender := func(_ context.Context, _ *sysenv.Env, _ string, r Request, _ string) (Receipt, error) {
						sends++
						return Receipt{Status: StatusAccepted}, nil
					}
					result, err := consumeWith(context.Background(), env, "fiber", "host", w, sender)
					if err != nil {
						t.Fatal(err)
					}
					want := "wait"
					if turn == "force" || (turn != "none" && state == "idle") {
						want = "wake"
					} else if turn != "none" && state == "costly" && cost == "fresh" {
						want = "fresh"
					}
					if result.Action != want || (sends == 1) != (want == "wake") {
						t.Fatalf("got %+v, sends %d; want %s", result, sends, want)
					}
					if want == "fresh" {
						for i := 0; i < 3; i++ {
							result, err = consumeWith(context.Background(), env, "fiber", "host", w, sender)
							if err != nil || result.Action != "wait" {
								t.Fatalf("repeated launch: %+v %v", result, err)
							}
						}
						w.Costly = false
						result, err = consumeWith(context.Background(), env, "fiber", "host", w, sender)
						if err != nil || result.Action != "wake" {
							t.Fatalf("refused launch fallback: %+v %v", result, err)
						}
					}
					root := mailboxDir(env, "fiber", "fiber")
					eligible := fiberContextHookEligible(root, Request{MessageID: "m"})
					if want == "wait" && eligible != (turn == "none" || turn == "ask") {
						t.Fatalf("hook eligible=%v for %s", eligible, turn)
					}
				})
			}
		}
	}
}

func TestConsumeOneBatchAndLimits(t *testing.T) {
	for _, n := range []int{3, 20} {
		t.Run(fmt.Sprint(n), func(t *testing.T) {
			env, w := consumeFixture(t)
			w.Idle = true
			for i := 0; i < n; i++ {
				putWish(t, env, fmt.Sprintf("m%02d", i), "ask", "hold")
			}
			calls := 0
			result, err := consumeWith(context.Background(), env, "fiber", "host", w, func(_ context.Context, _ *sysenv.Env, _ string, r Request, _ string) (Receipt, error) {
				calls++
				for i := 0; i < min(n, 16); i++ {
					if !strings.Contains(r.Text, fmt.Sprintf("text of m%02d", i)) {
						t.Fatalf("missing member: %s", r.Text)
					}
				}
				return Receipt{Status: StatusAccepted}, nil
			})
			if err != nil || calls != 1 || len(result.Members) != min(n, 16) {
				t.Fatalf("%+v calls=%d err=%v", result, calls, err)
			}
		})
	}
}

func TestConsumeFrozenBatchAcrossCrash(t *testing.T) {
	for _, afterSend := range []bool{false, true} {
		t.Run(fmt.Sprint(afterSend), func(t *testing.T) {
			env, w := consumeFixture(t)
			w.Idle = true
			for _, id := range []string{"one", "two", "three"} {
				putWish(t, env, id, "ask", "hold")
			}
			root := mailboxDir(env, "fiber", "fiber")
			items, err := pendingItems(root)
			if err != nil {
				t.Fatal(err)
			}
			a := newConsumedAttempt(w, items, true)
			if err := pinConsumedBatch(root, &a); err != nil {
				t.Fatal(err)
			}
			// A newly queued item cannot change an open attempt's text or membership.
			putWish(t, env, "later", "none", "hold")
			receipts := map[string]string{}
			injected := 0
			sender := func(_ context.Context, _ *sysenv.Env, _ string, r Request, address string) (Receipt, error) {
				key := address + "/" + r.MessageID
				if text, ok := receipts[key]; ok {
					if text != r.Text {
						t.Fatal("transport id reused with different text")
					}
				} else {
					receipts[key] = r.Text
					injected++
				}
				return Receipt{Status: StatusAccepted}, nil
			}
			if afterSend {
				_, _ = sender(context.Background(), env, "host", *a.Payload, w.Address)
			}
			result, err := consumeWith(context.Background(), env, "fiber", "host", w, sender)
			if err != nil || injected != 1 || len(result.Members) != 3 {
				t.Fatalf("%+v injected=%d err=%v", result, injected, err)
			}
			if n, _ := PendingCount(env, "fiber"); n != 1 {
				t.Fatalf("pending=%d", n)
			}
		})
	}
}

func TestConsumePartialClaimAndClose(t *testing.T) {
	for _, partialClose := range []bool{false, true} {
		t.Run(fmt.Sprint(partialClose), func(t *testing.T) {
			env, w := consumeFixture(t)
			w.Idle = true
			putWish(t, env, "one", "ask", "hold")
			putWish(t, env, "two", "ask", "hold")
			root := mailboxDir(env, "fiber", "fiber")
			items, _ := pendingItems(root)
			a := newConsumedAttempt(w, items, true)
			if err := pinConsumedBatch(root, &a); err != nil {
				t.Fatal(err)
			}
			if partialClose {
				if err := closeAttempts([]string{items[0].path}, attemptDelivered); err != nil {
					t.Fatal(err)
				}
			} else {
				e := items[1].entry
				if err := writeMailboxEntry(items[1].path, e); err != nil {
					t.Fatal(err)
				}
				if fiberContextHookEligible(root, e.Request) {
					t.Fatal("hook stole a partially claimed member")
				}
			}
			_, err := consumeWith(context.Background(), env, "fiber", "host", w, func(_ context.Context, _ *sysenv.Env, _ string, r Request, _ string) (Receipt, error) {
				if r.Text != a.Payload.Text || r.MessageID != a.Payload.MessageID {
					t.Fatal("changed frozen emission")
				}
				return Receipt{Status: StatusAccepted}, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			if n, _ := PendingCount(env, "fiber"); n != 0 {
				t.Fatal(n)
			}
		})
	}
}

func TestConsumeRollForwardABAAndRetry(t *testing.T) {
	env, w := consumeFixture(t)
	w.Idle = true
	putWish(t, env, "one", "ask", "hold")
	putWish(t, env, "two", "none", "hold")
	texts := map[string]string{}
	ids := []string{}
	sender := func(_ context.Context, _ *sysenv.Env, _ string, r Request, address string) (Receipt, error) {
		key := address + "/" + r.MessageID
		if old, ok := texts[key]; ok && old != r.Text {
			t.Fatal("message_id_conflict")
		}
		texts[key] = r.Text
		ids = append(ids, key)
		return Receipt{Status: StatusUnknown}, errCode("ambiguous_delivery", "unknown")
	}
	_, _ = consumeWith(context.Background(), env, "fiber", "host", w, sender)
	root := mailboxDir(env, "fiber", "fiber")
	for _, id := range []string{"B", "A"} {
		a, err := readConsumedBatch(root)
		if err != nil {
			t.Fatal(err)
		}
		a.OpenedAt = time.Now().Add(-liveAttemptRetryAfter).UnixNano()
		if err := pinConsumedBatch(root, &a); err != nil {
			t.Fatal(err)
		}
		if err := RegisterMailbox(env, "claude", id, "host", t.TempDir(), os.Getpid(), true); err != nil {
			t.Fatal(err)
		}
		w.Address = "shuttle://host/claude/" + id
		w.Epoch = transition(t, env, id, w.Address)
		_, _ = consumeWith(context.Background(), env, "fiber", "host", w, sender)
	}
	if len(texts) != 3 {
		t.Fatalf("ids=%v", ids)
	}
	a, _ := readConsumedBatch(root)
	a.OpenedAt = time.Now().Add(-liveAttemptRetryAfter).UnixNano()
	_ = pinConsumedBatch(root, &a)
	_, _ = consumeWith(context.Background(), env, "fiber", "host", w, sender)
	a, _ = readConsumedBatch(root)
	if a.Retry != 1 {
		t.Fatalf("retry=%d", a.Retry)
	}
	a.OpenedAt = time.Now().Add(-liveAttemptRetryAfter).UnixNano()
	_ = pinConsumedBatch(root, &a)
	before := len(texts)
	_, _ = consumeWith(context.Background(), env, "fiber", "host", w, sender)
	if len(texts) != before {
		t.Fatal("unbounded retry")
	}
}

func TestConsumeOldPinUsesOldTransportID(t *testing.T) {
	for _, oldRecord := range []bool{false, true} {
		t.Run(fmt.Sprint(oldRecord), func(t *testing.T) {
			env, w := consumeFixture(t)
			putWish(t, env, "old", "force", "hold")
			path := filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending", mailboxKey("old")+".json")
			if oldRecord {
				_, err := claimBatch([]string{path}, w.Address, true)
				if err != nil {
					t.Fatal(err)
				}
			} else {
				if err := writeFiberMailboxAttempt(path, readEntry(t, path), w.Address); err != nil {
					t.Fatal(err)
				}
			}
			_, err := consumeWith(context.Background(), env, "fiber", "host", w, func(_ context.Context, _ *sysenv.Env, _ string, r Request, address string) (Receipt, error) {
				if r.MessageID != "old" || r.Text != "text of old" || address != w.Address {
					t.Fatalf("changed old send %+v %s", r, address)
				}
				return Receipt{Status: StatusAccepted}, nil
			})
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestConsumeBatchSizeLimit(t *testing.T) {
	env, w := consumeFixture(t)
	w.Idle = true
	for _, id := range []string{"one", "two", "three"} {
		if err := Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: id, Text: strings.Repeat("x", 3000)}, Wishes: Wishes{Turn: "ask"}}); err != nil {
			t.Fatal(err)
		}
	}
	result, err := consumeWith(context.Background(), env, "fiber", "host", w, func(_ context.Context, _ *sysenv.Env, _ string, r Request, _ string) (Receipt, error) {
		if len(Labeled(r)) > claudeHookBatchBytes {
			t.Fatalf("oversized %d", len(Labeled(r)))
		}
		return Receipt{Status: StatusAccepted}, nil
	})
	if err != nil || len(result.Members) != 2 {
		t.Fatalf("%+v %v", result, err)
	}
}

func TestConsumeOpenBatchHoldsOnlyItsMembers(t *testing.T) {
	for _, code := range []string{"wake_held", "ambiguous_delivery"} {
		t.Run(code, func(t *testing.T) {
			env, w := consumeFixture(t)
			w.Idle = true
			putWish(t, env, "stuck", "ask", "hold")
			putWish(t, env, "context", "none", "hold")
			var sent []string
			sender := func(_ context.Context, _ *sysenv.Env, _ string, r Request, _ string) (Receipt, error) {
				sent = append(sent, r.Text)
				if strings.Contains(r.Text, "text of stuck") {
					return Receipt{Status: StatusUnknown}, errCode(code, "outcome unknown")
				}
				return Receipt{Status: StatusAccepted}, nil
			}
			_, _ = consumeWith(context.Background(), env, "fiber", "host", w, sender)
			putWish(t, env, "f", "force", "hold")
			w.Idle = false
			result, _ := consumeWith(context.Background(), env, "fiber", "host", w, sender)
			if !strings.Contains(sent[len(sent)-1], "text of f") || strings.Contains(sent[len(sent)-1], "text of context") {
				t.Fatalf("force entry behind an open batch: %+v sent %q", result, sent)
			}
			if n, _ := PendingCount(env, "fiber"); n != 2 {
				t.Fatalf("pending=%d, want the open batch's two members", n)
			}
			root := mailboxDir(env, "fiber", "fiber")
			if fiberContextHookEligible(root, Request{MessageID: "context"}) {
				t.Fatal("hook took a member of an open batch")
			}
		})
	}
}

func TestConsumeFreshReservationIsLeased(t *testing.T) {
	env, w := consumeFixture(t)
	w.Idle, w.Costly = true, true
	putWish(t, env, "m", "ask", "fresh")
	never := func(context.Context, *sysenv.Env, string, Request, string) (Receipt, error) {
		t.Fatal("costly worker woken")
		return Receipt{}, nil
	}
	for _, want := range []string{"fresh", "wait"} {
		if result, err := consumeWith(context.Background(), env, "fiber", "host", w, never); err != nil || result.Action != want {
			t.Fatalf("got %+v %v, want %s", result, err, want)
		}
	}
	path := filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending", mailboxKey("m")+".json")
	e := readEntry(t, path)
	e.Attempt.OpenedAt = time.Now().Add(-3 * time.Minute).UnixNano()
	if err := writeMailboxEntry(path, e); err != nil {
		t.Fatal(err)
	}
	if result, err := consumeWith(context.Background(), env, "fiber", "host", w, never); err != nil || result.Action != "fresh" {
		t.Fatalf("an unanswered reservation never asks again: %+v %v", result, err)
	}
}

func TestConsumeMarksAnUnfinishedHookClaimAsPossibleRepeat(t *testing.T) {
	env, w := consumeFixture(t)
	w.Idle = true
	putWish(t, env, "m", "ask", "hold")
	path := filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending", mailboxKey("m")+".json")
	if _, err := claimBatch([]string{path}, w.Address, false); err != nil {
		t.Fatal(err)
	}
	var text string
	_, err := consumeWith(context.Background(), env, "fiber", "host", w, func(_ context.Context, _ *sysenv.Env, _ string, r Request, _ string) (Receipt, error) {
		text = r.Text
		return Receipt{Status: StatusAccepted}, nil
	})
	if err != nil || !strings.HasPrefix(text, "Possible repeat:") {
		t.Fatalf("unfinished hook claim sent unmarked: %q %v", text, err)
	}
}

func TestConsumeSupersededMemberAfterTheBatchsReceipt(t *testing.T) {
	for _, sentBefore := range []bool{true, false} {
		t.Run(fmt.Sprint(sentBefore), func(t *testing.T) {
			env, w := consumeFixture(t)
			w.Idle = true
			scripts := t.TempDir()
			script := filepath.Join(scripts, "shuttle")
			current := func(answer string) {
				if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf '{\"current\":"+answer+"}\\n'\n"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			current("true")
			env.Set("PATH", scripts+string(os.PathListSeparator)+env.Getenv("PATH"))
			signal := &ThreadSignal{UID: "child", Verb: "closed", Owner: "host", Stamp: time.Now().UTC().Format(time.RFC3339Nano)}
			if err := Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: "thread-m", Text: "thread child closed: result", ThreadSignal: signal}, Wishes: Wishes{Turn: "ask"}}); err != nil {
				t.Fatal(err)
			}
			putWish(t, env, "plain", "ask", "hold")
			root := mailboxDir(env, "fiber", "fiber")
			items, err := pendingItems(root)
			if err != nil {
				t.Fatal(err)
			}
			a := newConsumedAttempt(w, items, true)
			if err := pinConsumedBatch(root, &a); err != nil {
				t.Fatal(err)
			}
			var texts []string
			sender := func(ctx context.Context, env *sysenv.Env, _ string, r Request, address string) (Receipt, error) {
				r.Address = address
				r.MessageID += "-" + mailboxKey(address)[:16]
				return withDedup(ctx, env, r, func(context.Context) dedupSendResult {
					texts = append(texts, r.Text)
					return dedupSendResult{Receipt: Receipt{MessageID: r.MessageID, Status: StatusAccepted}}
				})
			}
			if sentBefore {
				// The CLI died after a confirmed send and before the close.
				_, _ = sender(context.Background(), env, "host", *a.Payload, w.Address)
			}
			current("false")
			_, _ = consumeWith(context.Background(), env, "fiber", "host", w, sender)
			plain := readEntry(t, filepath.Join(root, "offered", mailboxKey("plain")+".json"))
			if plain.PossibleRepeat {
				t.Fatalf("plain member marked as a possible repeat: %+v", plain)
			}
			if sentBefore && (len(texts) != 1 || plain.Attempt.Outcome != attemptDelivered) {
				t.Fatalf("a delivered batch was sent again: %q %+v", texts, plain.Attempt)
			}
			if !sentBefore && (len(texts) != 1 || strings.Contains(texts[0], "thread child closed") || strings.Contains(texts[0], "Possible repeat")) {
				t.Fatalf("never-sent batch: %q", texts)
			}
		})
	}
}

func TestConsumeLaunchedSessionTakesAReservationThroughItsHook(t *testing.T) {
	env, w := consumeFixture(t)
	w.Idle, w.Costly = true, true
	putWish(t, env, "m", "ask", "fresh")
	sends := 0
	sender := func(context.Context, *sysenv.Env, string, Request, string) (Receipt, error) {
		sends++
		return Receipt{Status: StatusAccepted}, nil
	}
	if result, _ := consumeWith(context.Background(), env, "fiber", "host", w, sender); result.Action != "fresh" {
		t.Fatalf("got %+v", result)
	}
	if err := RegisterMailbox(env, "claude", "B", "host", t.TempDir(), os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	launched := Worker{Address: "shuttle://host/claude/B", Epoch: transition(t, env, "B", "shuttle://host/claude/B"), Idle: true}
	result, err := consumeWith(context.Background(), env, "fiber", "host", launched, sender)
	if err != nil || result.Action != "wait" || result.Turn || sends != 0 {
		t.Fatalf("launched session woken for its own reservation: %+v %v", result, err)
	}
	if !fiberContextHookEligible(mailboxDir(env, "fiber", "fiber"), Request{MessageID: "m"}) {
		t.Fatal("launched session's hook cannot take the reservation")
	}
	path := filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending", mailboxKey("m")+".json")
	e := readEntry(t, path)
	e.Attempt.OpenedAt = time.Now().Add(-3 * time.Minute).UnixNano()
	if err := writeMailboxEntry(path, e); err != nil {
		t.Fatal(err)
	}
	if result, err := consumeWith(context.Background(), env, "fiber", "host", launched, sender); err != nil || result.Action != "wake" || sends != 1 {
		t.Fatalf("an expired reservation still holds the entry: %+v %v", result, err)
	}
}

func TestConsumeChecksThreadSignalsOnlyToReserveOrWake(t *testing.T) {
	env, w := consumeFixture(t)
	calls := filepath.Join(t.TempDir(), "calls")
	scripts := t.TempDir()
	if err := os.WriteFile(filepath.Join(scripts, "shuttle"), []byte("#!/bin/sh\necho call >> "+calls+"\nprintf '{\"current\":false}\\n'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	env.Set("PATH", scripts+string(os.PathListSeparator)+env.Getenv("PATH"))
	put := func(id, turn string) {
		t.Helper()
		signal := &ThreadSignal{UID: id, Verb: "closed", Owner: "host", Stamp: time.Now().UTC().Format(time.RFC3339Nano)}
		if err := Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: "thread-" + id, Text: "thread " + id + " closed", ThreadSignal: signal}, Wishes: Wishes{Turn: turn}}); err != nil {
			t.Fatal(err)
		}
	}
	countCalls := func() int {
		bytes, _ := os.ReadFile(calls)
		return strings.Count(string(bytes), "call")
	}
	sends := 0
	sender := func(_ context.Context, _ *sysenv.Env, _ string, r Request, _ string) (Receipt, error) {
		sends++
		return Receipt{Status: StatusAccepted}, nil
	}
	for _, id := range []string{"a", "b", "c"} {
		put(id, "none")
	}
	put("d", "ask")
	for i := 0; i < 5; i++ {
		result, err := consumeWith(context.Background(), env, "fiber", "host", w, sender)
		if err != nil || result.Action != "wait" || !result.Turn {
			t.Fatalf("busy consume: %+v %v", result, err)
		}
	}
	if n := countCalls(); n != 0 {
		t.Fatalf("a waiting consume checked %d thread signals", n)
	}
	w.Idle = true
	result, err := consumeWith(context.Background(), env, "fiber", "host", w, sender)
	if err != nil || result.Action != "wait" || sends != 0 {
		t.Fatalf("superseded wake: %+v %v, sends %d", result, err, sends)
	}
	if countCalls() == 0 {
		t.Fatal("the wake path did not check its thread signals")
	}
	offered, _ := os.ReadDir(filepath.Join(mailboxDir(env, "fiber", "fiber"), "offered"))
	if len(offered) != 4 {
		t.Fatalf("superseded notices offered: %d", len(offered))
	}
}

func TestConsumeSendsQuietContextToAHooklessReceiver(t *testing.T) {
	env := testEnv(t)
	w := Worker{Address: "shuttle://host/pi/P", Epoch: transition(t, env, "P", "shuttle://host/pi/P")}
	putWish(t, env, "quiet", "none", "hold")
	putWish(t, env, "asked", "ask", "hold")
	var sent []Request
	sender := func(_ context.Context, _ *sysenv.Env, _ string, r Request, _ string) (Receipt, error) {
		sent = append(sent, r)
		return Receipt{Status: StatusAccepted}, nil
	}
	result, err := consumeWith(context.Background(), env, "fiber", "host", w, sender)
	if err != nil || result.Action != "context" || !result.Turn || len(result.Members) != 1 || result.Members[0] != "quiet" {
		t.Fatalf("hookless consume: %+v %v", result, err)
	}
	if len(sent) != 1 || sent[0].Wake || sent[0].Text != "text of quiet" {
		t.Fatalf("sent %+v", sent)
	}
	w.Idle = true
	result, err = consumeWith(context.Background(), env, "fiber", "host", w, sender)
	if err != nil || result.Action != "wake" || len(sent) != 2 || !sent[1].Wake || sent[1].Text != "text of asked" {
		t.Fatalf("idle consume: %+v %v, sent %+v", result, err, sent)
	}
}

func TestConsumeLeavesQuietContextToAHooklessCodexReceiver(t *testing.T) {
	env := testEnv(t)
	w := Worker{Address: "shuttle://host/codex/C", Epoch: transition(t, env, "C", "shuttle://host/codex/C")}
	putWish(t, env, "quiet", "none", "hold")
	sender := func(_ context.Context, _ *sysenv.Env, _ string, r Request, _ string) (Receipt, error) {
		t.Fatalf("sent %+v", r)
		return Receipt{}, nil
	}
	result, err := consumeWith(context.Background(), env, "fiber", "host", w, sender)
	if err != nil || result.Action != "wait" {
		t.Fatalf("codex consume: %+v %v", result, err)
	}
}
