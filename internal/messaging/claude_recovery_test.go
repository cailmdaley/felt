package messaging

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"
)

func TestClaudeAutomaticContextOnlyRejectedBeforeDelivery(t *testing.T) {
	env := testEnv(t)
	req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
	req.Wake, req.ContextIfBusy = false, true
	_, err := Send(context.Background(), env, "host", req)
	if ErrorCode(err) != "invalid_request" {
		t.Fatalf("context-only automatic hint accepted: %v", err)
	}
	if err := RecoverClaudeMail(context.Background(), env, "host", time.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if sent.Load() != 0 || pendingMailboxText(t, env, "claude", "session", req.Text) {
		t.Fatal("rejected request reached a transport")
	}
}

func TestClaudeAutomaticRequiresNativeCapability(t *testing.T) {
	env := testEnv(t)
	req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
	req.ContextIfBusy = true
	_ = SetMailboxState(env, "claude", "session", "host", "working")
	if err := os.Remove(filepath.Join(mailboxDir(env, "claude", "session"), "native.json")); err != nil {
		t.Fatal(err)
	}
	receipt, err := Send(context.Background(), env, "host", req)
	if ErrorCode(err) != "preflight_failed" || receipt.Status != StatusRejected || sent.Load() != 0 || pendingMailboxText(t, env, "claude", "session", req.Text) {
		t.Fatalf("accepted automatic mail without fallback: %+v %v writes=%d", receipt, err, sent.Load())
	}
}

func TestClaudeAbandonedFallbackIsDurablyUnknown(t *testing.T) {
	env := testEnv(t)
	req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
	req.ContextIfBusy = true
	_ = SetMailboxState(env, "claude", "session", "host", "working")
	if _, err := Send(context.Background(), env, "host", req); err != nil {
		t.Fatal(err)
	}
	dir, key := mailboxDir(env, "claude", "session"), mailboxKey(req.MessageID)+".json"
	if claimed, err := claimClaudeFallback(dir, key); err != nil || !claimed {
		t.Fatalf("claim=%v %v", claimed, err)
	}
	entry, err := readFiberMailboxEntry(filepath.Join(dir, "fallback", key))
	if err != nil {
		t.Fatal(err)
	}
	nativeReq := entry.Request
	nativeReq.Wake, nativeReq.ContextIfBusy = true, false
	fallbackKey := req
	fallbackKey.MessageID = claudeFallbackKeyPrefix + req.MessageID
	writeDedupRecord(t, dataDir(env), fallbackKey, record{Hash: requestHash(nativeReq), State: "reserved", OwnerPID: os.Getpid(), OwnerStart: "not-this-process"})
	// Even before another recovery pass, the original sender sees uncertainty.
	if got, err := Send(context.Background(), env, "host", req); got.Status != StatusUnknown || ErrorCode(err) != "ambiguous_delivery" {
		t.Fatalf("abandoned attempt hidden by hook receipt: %+v %v", got, err)
	}
	if err := RecoverClaudeMail(context.Background(), env, "host", time.Now().Add(time.Minute)); err == nil {
		t.Fatal("abandoned native attempt reported successful recovery")
	}
	if err := RecoverClaudeMail(context.Background(), env, "host", time.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	got, err := Send(context.Background(), env, "host", req)
	if got.Status != StatusUnknown || ErrorCode(err) != "ambiguous_delivery" || sent.Load() != 0 {
		t.Fatalf("retry=%+v %v writes=%d", got, err, sent.Load())
	}
	stored, err := readDedupRecord(dedupRecordPath(env, fallbackKey.MessageID))
	if err != nil || stored.State != "complete" || stored.Receipt.Status != StatusUnknown || stored.ErrorCode != "ambiguous_delivery" {
		t.Fatalf("uncertainty not durable: %+v %v", stored, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "offered", key)); err != nil {
		t.Fatal(err)
	}
}

func TestClaudeFallbackRetainsAttachmentAndIdleReceipt(t *testing.T) {
	env := testEnv(t)
	req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
	req.ContextIfBusy, req.NotifyWhenIdle = true, true
	req.NotifyAddress = "shuttle://peer/pi/sender"
	req.Attachments = []Attachment{testAttachment("plot.txt", []byte("private fixture"))}
	_ = SetMailboxState(env, "claude", "session", "host", "working")
	queued, err := Send(context.Background(), env, "host", req)
	if err != nil || len(queued.Files) != 1 || queued.Idle == nil {
		t.Fatalf("initial=%+v %v", queued, err)
	}
	if err := RecoverClaudeMail(context.Background(), env, "host", time.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	got, err := Send(context.Background(), env, "host", req)
	if err != nil || got.Status != StatusAccepted || got.Transport != claudeNativeTransport || sent.Load() != 1 || !reflect.DeepEqual(got.Files, queued.Files) || !reflect.DeepEqual(got.Idle, queued.Idle) {
		t.Fatalf("fallback lost receipt metadata: %+v %v; initial=%+v writes=%d", got, err, queued, sent.Load())
	}
}

func TestClaudeFallbackRetryAdvancesNativeEvidence(t *testing.T) {
	for _, stage := range []string{StatusQueued, StatusSubmitted, StatusUnknown} {
		t.Run(stage, func(t *testing.T) {
			env := testEnv(t)
			req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
			req.ContextIfBusy = true
			_ = SetMailboxState(env, "claude", "session", "host", "working")
			if _, err := Send(context.Background(), env, "host", req); err != nil {
				t.Fatal(err)
			}
			nativeReq := req
			nativeReq.ContextIfBusy = false
			fallbackKey := req
			fallbackKey.MessageID = claudeFallbackKeyPrefix + req.MessageID
			offset := int64(0)
			stored := record{Hash: requestHash(nativeReq), State: "complete", Receipt: Receipt{MessageID: req.MessageID, Address: req.Address, Transport: claudeNativeTransport, Status: stage}, TranscriptOffset: &offset, ClaudeQueueContentHash: nativeContentHash(labeled(nativeReq))}
			if stage == StatusUnknown {
				stored.ErrorCode, stored.ErrorMessage = "ambiguous_delivery", "no reply yet"
			}
			writeDedupRecord(t, dataDir(env), fallbackKey, stored)
			registration, err := readClaudeNative(env, "session")
			if err != nil {
				t.Fatal(err)
			}
			f, err := os.OpenFile(registration.Transcript, os.O_APPEND|os.O_WRONLY, 0600)
			if err != nil {
				t.Fatal(err)
			}
			nativeRows(map[string]any{"uuid": claudeNativeUUID(nativeReq)}, f, false)
			f.Close()
			got, err := Send(context.Background(), env, "host", req)
			if err != nil || got.Status != StatusAccepted || got.Transport != claudeNativeTransport || sent.Load() != 0 {
				t.Fatalf("stale native evidence: %+v %v writes=%d", got, err, sent.Load())
			}
			upgraded, err := readDedupRecord(dedupRecordPath(env, fallbackKey.MessageID))
			if err != nil || upgraded.Receipt.Status != StatusAccepted || upgraded.ErrorCode != "" {
				t.Fatalf("upgrade not durable: %+v %v", upgraded, err)
			}
		})
	}
}

func TestClaudeFallbackRestartsAfterDurableClaim(t *testing.T) {
	for _, boundary := range []string{"flagged", "renamed"} {
		t.Run(boundary, func(t *testing.T) {
			env := testEnv(t)
			req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
			req.ContextIfBusy = true
			_ = SetMailboxState(env, "claude", "session", "host", "working")
			if _, err := Send(context.Background(), env, "host", req); err != nil {
				t.Fatal(err)
			}
			dir, key := mailboxDir(env, "claude", "session"), mailboxKey(req.MessageID)+".json"
			if boundary == "flagged" {
				path := filepath.Join(dir, "pending", key)
				entry, err := readFiberMailboxEntry(path)
				if err != nil {
					t.Fatal(err)
				}
				entry.NativeFallback = true
				b, _ := json.Marshal(entry)
				if err := mailboxWrite(path, b, false); err != nil {
					t.Fatal(err)
				}
			} else if claimed, err := claimClaudeFallback(dir, key); err != nil || !claimed {
				t.Fatalf("claim=%v %v", claimed, err)
			}
			if err := OfferMailbox(env, "claude", "session", "host", func([]Request) error { t.Error("claimed message reached hook"); return nil }); err != nil {
				t.Fatal(err)
			}
			if err := RecoverClaudeMail(context.Background(), env.Clone(), "host", time.Now().Add(time.Minute)); err != nil {
				t.Fatal(err)
			}
			if got, err := Send(context.Background(), env, "host", req); err != nil || got.Status != StatusAccepted || sent.Load() != 1 {
				t.Fatalf("restart=%+v %v writes=%d", got, err, sent.Load())
			}
		})
	}
}

func TestClaudeSlowFallbackDoesNotDelayNewerMessage(t *testing.T) {
	env := testEnv(t)
	firstReceived, newerReceived, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) {
		if frame["uuid"] == claudeNativeUUID(Request{Address: "shuttle://host/claude/session", MessageID: "native-test"}) {
			close(firstReceived)
			<-release
		}
		nativeRows(frame, f, false)
		if frame["uuid"] == claudeNativeUUID(Request{Address: "shuttle://host/claude/session", MessageID: "newer-message"}) {
			close(newerReceived)
		}
	})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock()
	req.ContextIfBusy = true
	_ = SetMailboxState(env, "claude", "session", "host", "working")
	if _, err := Send(context.Background(), env, "host", req); err != nil {
		t.Fatal(err)
	}
	first := make(chan error, 1)
	go func() { first <- RecoverClaudeMail(context.Background(), env, "host", time.Now().Add(time.Minute)) }()
	select {
	case <-firstReceived:
	case <-time.After(10 * time.Second):
		t.Fatal("first fallback never reached native receiver")
	}
	newer := req
	newer.MessageID, newer.Text = "newer-message", "second"
	if _, err := Send(context.Background(), env, "host", newer); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// Transport selection uses a nonblocking mailbox lock; contention can skip
	// an entry for a tick. Drive subsequent ticks without waiting for the older
	// native observation to finish.
	for delivered := false; !delivered; {
		if err := RecoverClaudeMail(ctx, env, "host", time.Now().Add(time.Minute)); err != nil {
			t.Fatal(err)
		}
		select {
		case <-newerReceived:
			delivered = true
		default:
		}
		if err := ctx.Err(); err != nil {
			t.Fatal("older observation blocked newer fallback")
		}
	}
	if got, err := Send(context.Background(), env, "host", newer); err != nil || got.Status != StatusAccepted || sent.Load() != 2 {
		t.Fatalf("newer=%+v %v writes=%d", got, err, sent.Load())
	}
	// Keep the older observer from outliving the fixture's private files.
	unblock()
	if err := <-first; err != nil {
		t.Fatal(err)
	}
}

func TestClaudeRecoveryCancellationBoundsSaturatedBatch(t *testing.T) {
	env := testEnv(t)
	received := make(chan struct{}, 9)
	req, sent := nativeClaudeFixture(t, env, func(map[string]any, *os.File) { received <- struct{}{} })
	req.ContextIfBusy = true
	registration, err := readClaudeNative(env, "session")
	if err != nil {
		t.Fatal(err)
	}
	// Separate mailboxes avoid contention on the short transport-selection
	// lock, so this tests the native observation slots rather than that lock.
	for i := 0; i < 9; i++ {
		id := fmt.Sprintf("batch-%d", i)
		if err := RegisterMailbox(env, "claude", id, "host", dataDir(env), os.Getpid(), true); err != nil {
			t.Fatal(err)
		}
		if err := RegisterClaudeNative(env, id, "host", dataDir(env), registration.Socket, registration.Transcript, true); err != nil {
			t.Fatal(err)
		}
		if err := SetMailboxState(env, "claude", id, "host", "working"); err != nil {
			t.Fatal(err)
		}
		req.MessageID, req.Address = id, "shuttle://host/claude/"+id
		if _, err := Send(context.Background(), env, "host", req); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- RecoverClaudeMail(ctx, env, "host", time.Now().Add(time.Minute)) }()
	for i := 0; i < 8; i++ {
		select {
		case <-received:
		case <-time.After(10 * time.Second):
			t.Fatal("batch failed to fill its eight observation slots")
		}
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation not propagated: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("batch outlived its context")
	}
	if sent.Load() != 8 {
		t.Fatalf("started an observation after cancellation: %d", sent.Load())
	}
	pending, err := filepath.Glob(filepath.Join(dataDir(env), "mailboxes", "claude", "*", "pending", "*.json"))
	if err != nil || len(pending) != 1 {
		t.Fatalf("unstarted work not retained: %v %v", pending, err)
	}
	for i := 0; i < 9; i++ {
		path := dedupRecordPath(env, claudeFallbackKeyPrefix+fmt.Sprintf("batch-%d", i))
		stored, err := readDedupRecord(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil || stored.State != "complete" || stored.Receipt.Status != StatusUnknown {
			t.Fatalf("canceled native observation left an abandoned reservation: %+v %v", stored, err)
		}
	}
}
