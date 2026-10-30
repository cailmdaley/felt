package messaging

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestMailboxReservationIgnoresPostLinkCleanupFailures(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	path := filepath.Join(dir, "reservation.json")
	payload := []byte(`{"nonce":"attempt-1"}`)
	removeCalls, syncCalls := 0, 0
	linked, err := mailboxWriteReservationWith(
		path,
		payload,
		os.Link,
		func(string) error {
			removeCalls++
			return errors.New("injected temp cleanup failure")
		},
		func(string) error {
			syncCalls++
			return errors.New("injected directory sync failure")
		},
	)
	if err != nil || !linked || removeCalls != 1 || syncCalls != 1 {
		t.Fatalf("reservation link: linked=%v err=%v remove=%d sync=%d", linked, err, removeCalls, syncCalls)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != string(payload) {
		t.Fatalf("linked reservation missing after cleanup errors: %q %v", got, err)
	}
}

func TestMailboxQueueOfferAndReplay(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	if err := RegisterMailbox(env, "claude", "session", "host", "/project", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	req := Request{Address: "shuttle://host/claude/session", Text: "peer context\n$(never execute)", From: "other-session", MessageID: "id-1"}
	r, err := Send(context.Background(), env, "host", req)
	if err != nil || r.Status != StatusQueued {
		t.Fatalf("send: %+v %v", r, err)
	}
	r2, err := Send(context.Background(), env, "host", req)
	if err != nil || !reflect.DeepEqual(r2, r) {
		t.Fatalf("retry: %+v %v", r2, err)
	}
	count := 0
	if err := OfferMailbox(env, "claude", "session", "host", func(rs []Request) error {
		count += len(rs)
		if len(rs) != 1 || !reflect.DeepEqual(rs[0], req) {
			t.Errorf("wrong context: %+v", rs)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := OfferMailbox(env, "claude", "session", "host", func(rs []Request) error { count += len(rs); return nil }); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("offered %d times", count)
	}
}

func TestMailboxRechecksThreadSignalImmediatelyBeforeEmit(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	root := mailboxDir(env, "fiber", "fiber")
	request := Request{MessageID: "thread-result", Text: "closed", ThreadSignal: &ThreadSignal{UID: "child", Verb: "closed", Stamp: time.Now().UTC().Format(time.RFC3339Nano), Owner: "owner"}}
	if err := QueueFiberContext(env, "fiber", request); err != nil {
		t.Fatal(err)
	}
	checks := 0
	emitted := false
	err := offerMailboxValidated(root, func(Request) bool { return true }, func(context.Context, Request) (bool, error) {
		checks++
		return checks == 1, nil
	}, func([]Request) error { emitted = true; return nil })
	if err != nil {
		t.Fatal(err)
	}
	if checks != 2 || emitted {
		t.Fatalf("checks=%d emitted=%v; stale lifecycle notice escaped", checks, emitted)
	}
	if count, err := PendingFiberContext(env, "fiber"); err != nil || count != 0 {
		t.Fatalf("superseded pending count = %d (%v)", count, err)
	}
}

func TestMailboxRechecksLegacyThreadNoticeImmediatelyBeforeEmit(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	root := mailboxDir(env, "fiber", "fiber")
	request := Request{MessageID: "thread-legacy-close", Text: "thread parent/child closed: result"}
	if err := QueueFiberContext(env, "fiber", request); err != nil {
		t.Fatal(err)
	}
	checks, emitted := 0, false
	err := offerMailboxValidated(root, func(Request) bool { return true }, func(context.Context, Request) (bool, error) {
		checks++
		return checks == 1, nil
	}, func([]Request) error { emitted = true; return nil })
	if err != nil {
		t.Fatal(err)
	}
	if checks != 2 || emitted {
		t.Fatalf("checks=%d emitted=%v; stale legacy thread notice escaped", checks, emitted)
	}
}

func TestSlowUnrelatedOwnerCannotMakeValidatedAskStaleAtEmit(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	root := mailboxDir(env, "fiber", "fiber")
	requests := []Request{
		{MessageID: "thread-ask", Text: "ask", ThreadSignal: &ThreadSignal{UID: "ask", Verb: "asked", Stamp: time.Now().UTC().Format(time.RFC3339Nano), Owner: "ask-owner"}},
		{MessageID: "thread-other", Text: "other", ThreadSignal: &ThreadSignal{UID: "other", Verb: "closed", Stamp: time.Now().UTC().Format(time.RFC3339Nano), Owner: "other-owner"}},
	}
	for _, request := range requests {
		if err := QueueFiberContext(env, "fiber", request); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(root, "pending", mailboxKey(request.MessageID)+".json")
		entry, err := readFiberMailboxEntry(path)
		if err != nil {
			t.Fatal(err)
		}
		if request.MessageID == "thread-other" {
			entry.QueuedAt = time.Now().Add(-time.Minute).UnixNano()
		} else {
			entry.QueuedAt = time.Now().Add(-time.Minute + time.Second).UnixNano()
		}
		bytes, err := json.Marshal(entry)
		if err != nil {
			t.Fatal(err)
		}
		if err := mailboxWrite(path, bytes, false); err != nil {
			t.Fatal(err)
		}
	}

	var mu sync.Mutex
	checks := map[string]int{}
	askCurrent := true
	askFirstCheck := make(chan struct{})
	otherSecondCheck := make(chan struct{})
	askSecondCheck := make(chan struct{})
	releaseOther := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(releaseOther) })
	current := func(_ context.Context, request Request) (bool, error) {
		mu.Lock()
		checks[request.MessageID]++
		call := checks[request.MessageID]
		mu.Unlock()
		switch request.MessageID {
		case "thread-ask":
			if call == 1 {
				close(askFirstCheck)
				return true, nil
			}
			mu.Lock()
			isCurrent := askCurrent
			mu.Unlock()
			close(askSecondCheck)
			return isCurrent, nil
		case "thread-other":
			if call == 1 {
				<-askFirstCheck
				return true, nil
			}
			close(otherSecondCheck)
			<-releaseOther
			mu.Lock()
			askCurrent = false
			mu.Unlock()
			return true, nil
		default:
			return false, nil
		}
	}
	var delivered []string
	done := make(chan error, 1)
	go func() {
		done <- offerMailboxEachValidated(root, func(Request) bool { return true }, current, func(request Request) error {
			delivered = append(delivered, request.MessageID)
			return nil
		})
	}()
	select {
	case <-otherSecondCheck:
	case <-time.After(2 * time.Second):
		t.Fatal("unrelated owner's final check did not start")
	}
	// A batch-wide parallel recheck can validate the ask here, then wait while
	// the unrelated owner's check supersedes it. The per-item path emits only
	// after that owner settles, so the ask's final check observes the new state.
	select {
	case <-askSecondCheck:
		// The old parallel shape reached the ask while the unrelated owner was
		// blocked; its result is captured as current before the state changes.
	case <-time.After(50 * time.Millisecond):
	}
	mu.Lock()
	askCurrent = false
	mu.Unlock()
	releaseOnce.Do(func() { close(releaseOther) })
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("mailbox delivery did not finish")
	}
	for _, id := range delivered {
		if id == "thread-ask" {
			t.Fatalf("stale ask was emitted with unrelated owner checks: %v", delivered)
		}
	}
}

func TestMailboxSkewedValidatorDeliversWithCaveat(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	root := mailboxDir(env, "fiber", "fiber")
	request := Request{MessageID: "thread-result", Text: "closed", ThreadSignal: &ThreadSignal{UID: "child", Verb: "closed", Stamp: time.Now().UTC().Format(time.RFC3339Nano), Owner: "owner"}}
	if err := QueueFiberContext(env, "fiber", request); err != nil {
		t.Fatal(err)
	}
	check := func(context.Context, Request) (bool, error) {
		return false, threadSignalSkewError{err: errors.New(`daemon at http://127.0.0.1:4000/api/v1/thread-signals/current returned 404: {"errors":{"detail":"Not Found"}}`)}
	}
	var delivered []Request
	if err := offerMailboxValidated(root, func(Request) bool { return true }, check, func(batch []Request) error {
		delivered = append(delivered, batch...)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(delivered) != 1 || !strings.HasPrefix(delivered[0].Text, staleThreadSignalCaveat) {
		t.Fatalf("skewed notice = %#v", delivered)
	}
}

func TestOfferedBodiesExpireAndExpiredReplayIsIgnored(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	root := mailboxDir(env, "fiber", "fiber")
	offered := filepath.Join(root, "offered")
	if err := os.MkdirAll(offered, 0700); err != nil {
		t.Fatal(err)
	}
	oldPath := filepath.Join(offered, mailboxKey("old")+".json")
	newPath := filepath.Join(offered, mailboxKey("new")+".json")
	for _, path := range []string{oldPath, newPath} {
		if err := os.WriteFile(path, []byte(`{"request":{}}`), 0600); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-mailboxRetention - time.Minute)
	if err := os.Chtimes(oldPath, old, old); err != nil {
		t.Fatal(err)
	}
	if err := pruneOffered(root, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
		t.Fatalf("expired offered payload remains: %v", err)
	}
	if _, err := os.Stat(newPath); err != nil {
		t.Fatalf("recent offered payload was pruned: %v", err)
	}
	request := Request{MessageID: "replayed", Text: "old result", RetainedAt: old.UTC().Format(time.RFC3339Nano)}
	if err := QueueFiberContext(env, "fiber", request); err != nil {
		t.Fatal(err)
	}
	if count, err := PendingFiberContext(env, "fiber"); err != nil || count != 0 {
		t.Fatalf("expired replay pending count = %d (%v)", count, err)
	}
}

func TestOfferRetiresExpiredPendingThreadNotice(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	root := mailboxDir(env, "fiber", "fiber")
	pending := filepath.Join(root, "pending")
	if err := os.MkdirAll(pending, 0700); err != nil {
		t.Fatal(err)
	}
	request := Request{MessageID: "thread-preupgrade", Text: "old close", ThreadSignal: &ThreadSignal{UID: "child", Verb: "closed", Stamp: time.Now().Add(-mailboxRetention - time.Minute).UTC().Format(time.RFC3339Nano), Owner: "host"}}
	path := filepath.Join(pending, mailboxKey(request.MessageID)+".json")
	bytes, err := json.Marshal(mailboxEntry{Request: request, QueuedAt: time.Now().UnixNano()})
	if err != nil {
		t.Fatal(err)
	}
	if err := mailboxWrite(path, bytes, false); err != nil {
		t.Fatal(err)
	}
	emitted := false
	err = offerMailboxValidated(root, func(Request) bool { return true }, func(context.Context, Request) (bool, error) {
		return true, nil
	}, func([]Request) error { emitted = true; return nil })
	if err != nil {
		t.Fatal(err)
	}
	if emitted {
		t.Fatal("expired pre-upgrade pending notice was emitted")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expired pending notice remains: %v", err)
	}
}

func TestOfferRetainsOldPendingOrdinaryContext(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir := mailboxDir(env, "claude", "session")
	pending := filepath.Join(dir, "pending")
	if err := os.MkdirAll(pending, 0700); err != nil {
		t.Fatal(err)
	}
	request := Request{Address: "shuttle://host/claude/session", MessageID: "ordinary-old", Text: "please review this"}
	path := filepath.Join(pending, mailboxKey(request.MessageID)+".json")
	queuedAt := time.Now().Add(-mailboxRetention - time.Minute).UnixNano()
	bytes, err := json.Marshal(mailboxEntry{Request: request, QueuedAt: queuedAt})
	if err != nil {
		t.Fatal(err)
	}
	if err := mailboxWrite(path, bytes, false); err != nil {
		t.Fatal(err)
	}
	var delivered []Request
	if err := offerMailbox(dir, func(Request) bool { return true }, func(batch []Request) error {
		delivered = append(delivered, batch...)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(delivered) != 1 || delivered[0].MessageID != request.MessageID {
		t.Fatalf("old ordinary context = %#v", delivered)
	}
}

func TestHourlyRetentionSweepPrunesDormantMailboxes(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	now := time.Now()
	root := filepath.Join(dataDir(env), "mailboxes", "claude", "dormant")
	offered := filepath.Join(root, "offered")
	if err := os.MkdirAll(offered, 0700); err != nil {
		t.Fatal(err)
	}
	oldPath := filepath.Join(offered, mailboxKey("dormant-old")+".json")
	if err := os.WriteFile(oldPath, []byte(`{"old":true}`), 0600); err != nil {
		t.Fatal(err)
	}
	old := now.Add(-mailboxRetention - time.Minute)
	if err := os.Chtimes(oldPath, old, old); err != nil {
		t.Fatal(err)
	}
	if err := PruneOfferedMailboxes(env, now); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
		t.Fatalf("dormant offered payload remains: %v", err)
	}

	recentSweepOldPath := filepath.Join(offered, mailboxKey("old-after-sweep")+".json")
	if err := os.WriteFile(recentSweepOldPath, []byte(`{"old":true}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(recentSweepOldPath, old, old); err != nil {
		t.Fatal(err)
	}
	if err := PruneOfferedMailboxes(env, now.Add(30*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(recentSweepOldPath); err != nil {
		t.Fatalf("hourly sweep rescanned too soon: %v", err)
	}
	if err := PruneOfferedMailboxes(env, now.Add(2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(recentSweepOldPath); !os.IsNotExist(err) {
		t.Fatalf("later hourly sweep retained dormant body: %v", err)
	}
}

func TestRegularHookQueueRejectsExpiredThreadReplay(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	if err := RegisterMailbox(env, "codex", "receiver", "host", "/project", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	request := Request{Address: "shuttle://host/codex/receiver", MessageID: "thread-old", Text: "old close", ThreadSignal: &ThreadSignal{UID: "child", Verb: "closed", Stamp: time.Now().Add(-mailboxRetention - time.Minute).UTC().Format(time.RFC3339Nano), Owner: "host"}}
	_, err := queueMailbox(env, Address{Host: "host", Harness: "codex", ID: "receiver"}, request)
	if err == nil {
		t.Fatal("expired replay was queued to the regular hook mailbox")
	}
	entries, readErr := os.ReadDir(filepath.Join(mailboxDir(env, "codex", "receiver"), "pending"))
	if readErr == nil && len(entries) != 0 {
		t.Fatalf("expired replay left pending entries: %v", entries)
	}
}

func TestRequestExpiryCannotBeOverriddenByNewerRetentionStamp(t *testing.T) {
	old := time.Now().Add(-mailboxRetention - time.Minute).UTC().Format(time.RFC3339Nano)
	request := Request{
		RetainedAt: time.Now().UTC().Format(time.RFC3339Nano),
		ThreadSignal: &ThreadSignal{
			Stamp: old,
		},
	}
	if !requestExpired(request, time.Now()) {
		t.Fatal("new retained_at hid the older lifecycle stamp")
	}
}

func TestMailboxOutputFailurePreservesPending(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	_ = RegisterMailbox(env, "claude", "s", "host", "/", os.Getpid(), true)
	r := Request{Address: "shuttle://host/claude/s", Text: "hello", MessageID: "m"}
	if _, err := Send(context.Background(), env, "host", r); err != nil {
		t.Fatal(err)
	}
	if err := OfferMailbox(env, "claude", "s", "host", func([]Request) error { return errors.New("closed output") }); err == nil {
		t.Fatal("expected error")
	}
	n := 0
	_ = OfferMailbox(env, "claude", "s", "host", func(rs []Request) error { n = len(rs); return nil })
	if n != 1 {
		t.Fatalf("lost pending message: %d", n)
	}
}

func TestMailboxConcurrentHooksOfferOnce(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	_ = RegisterMailbox(env, "claude", "s", "host", "/", os.Getpid(), true)
	for i := 0; i < 10; i++ {
		_, err := Send(context.Background(), env, "host", Request{Address: "shuttle://host/claude/s", Text: "hello", MessageID: fmt.Sprint(i)})
		if err != nil {
			t.Fatal(err)
		}
	}
	var mu sync.Mutex
	seen := map[string]int{}
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := OfferMailbox(env, "claude", "s", "host", func(rs []Request) error {
				mu.Lock()
				defer mu.Unlock()
				for _, r := range rs {
					seen[r.MessageID]++
				}
				return nil
			}); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if len(seen) != 10 {
		t.Fatalf("offered %d messages", len(seen))
	}
	for id, n := range seen {
		if n != 1 {
			t.Fatalf("%s offered %d times", id, n)
		}
	}
}

// Registration and SessionEnd serialize as one transition; readers never see
// an intermediate state while one hook is publishing.
func TestMailboxConcurrentRegistrationAndEndHaveOneAtomicState(t *testing.T) {
	t.Parallel()
	for _, firstActive := range []bool{false, true} {
		t.Run(fmt.Sprintf("first-active=%v", firstActive), func(t *testing.T) {
			env := testEnv(t)
			if err := RegisterMailbox(env, "pi", "session", "host", "/project", os.Getpid(), true); err != nil {
				t.Fatal(err)
			}
			published, resume := make(chan struct{}), make(chan struct{})
			var releaseOnce sync.Once
			release := func() { releaseOnce.Do(func() { close(resume) }) }
			defer release()
			done := make(chan error, 1)
			go func() {
				done <- registerMailboxWith(env, "pi", "session", "host", "/project", os.Getpid(), firstActive, func(path string, b []byte, exclusive bool) error {
					if err := mailboxWrite(path, b, exclusive); err != nil {
						return err
					}
					close(published)
					<-resume
					return nil
				})
			}()
			select {
			case <-published:
			case err := <-done:
				t.Fatalf("first transition did not publish: %v", err)
			case <-time.After(10 * time.Second):
				t.Fatal("first transition did not reach publication barrier")
			}
			secondDone := make(chan error, 1)
			go func() {
				secondDone <- RegisterMailbox(env, "pi", "session", "host", "/project", os.Getpid(), !firstActive)
			}()
			select {
			case err := <-secondDone:
				t.Fatalf("second transition bypassed the registration lock: %v", err)
			case <-time.After(20 * time.Millisecond):
			}
			release()
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			secondErr := <-secondDone
			if secondErr != nil {
				t.Fatal(secondErr)
			}
			reason := mailboxUnavailable(env, "pi", "session", "host")
			if firstActive && reason != "session has ended; its Shuttle message hook is withdrawn" {
				t.Fatalf("last publication is ended, got %q", reason)
			}
			if !firstActive && reason != "" {
				t.Fatalf("last publication is registered, got %q", reason)
			}
		})
	}
}

func TestMailboxWithdrawAndNoWake(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	_ = RegisterMailbox(env, "claude", "s", "host", "/", os.Getpid(), true)
	_, err := Send(context.Background(), env, "host", Request{Address: "shuttle://host/claude/s", Text: "hello", Wake: true, MessageID: "w"})
	if err == nil {
		t.Fatal("wake was accepted")
	}
	if err := RegisterMailbox(env, "claude", "s", "host", "/", os.Getpid(), false); err != nil {
		t.Fatal(err)
	}
	if MailboxAvailable(env, "claude", "s", "host") {
		t.Fatal("ended mailbox advertised")
	}
	_, err = Send(context.Background(), env, "host", Request{Address: "shuttle://host/claude/s", Text: "hello", MessageID: "n"})
	if err == nil {
		t.Fatal("unregistered mailbox accepted message")
	}
}

func TestCodexMailboxIsHostScopedAndDiscoverableAsHook(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	if err := RegisterMailbox(env, "codex", "thread-1", "owner", "/project", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	if MailboxAvailable(env, "codex", "thread-1", "other") {
		t.Fatal("mailbox leaked across host ownership")
	}
	sessions := mailboxSessions(env, "codex", "owner")
	if len(sessions) != 1 {
		t.Fatalf("sessions: %#v", sessions)
	}
	s := sessions[0]
	if s.State != "hook" || s.LastSeen == 0 || len(s.Capabilities) != 1 || s.Capabilities[0] != "context" {
		t.Fatalf("hook registration was mislabeled: %#v", s)
	}
	req := Request{Address: s.Address, Text: "context", MessageID: "m"}
	receipt, err := Send(context.Background(), env, "owner", req)
	if err != nil || receipt.Status != StatusQueued || receipt.Transport != "codex-hook" {
		t.Fatalf("send: %#v %v", receipt, err)
	}
	wrongHost := req
	wrongHost.Address = "shuttle://other/codex/thread-1"
	if _, err := Send(context.Background(), env, "other", wrongHost); err == nil {
		t.Fatal("foreign host accepted mailbox message")
	}
}

func TestMailboxWakeRejectedForEveryHookHarness(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	for _, harness := range []string{"claude", "codex"} {
		if err := RegisterMailbox(env, harness, "s", "host", "/", os.Getpid(), true); err != nil {
			t.Fatal(err)
		}
		req := Request{Address: "shuttle://host/" + harness + "/s", Text: "wake", Wake: true, MessageID: harness}
		if receipt, err := Send(context.Background(), env, "host", req); err == nil || receipt.Status != StatusRejected {
			t.Fatalf("%s wake: %#v %v", harness, receipt, err)
		}
	}
}

func TestMergeNativeAndHookSessionsPrefersNativeRecord(t *testing.T) {
	t.Parallel()
	hook := Session{Address: "shuttle://host/codex/id", Host: "host", Harness: "codex", ID: "id", State: "hook", Capabilities: []string{"context"}, LastSeen: 1}
	native := hook
	native.State = "active"
	native.LastSeen = 0
	native.Capabilities = []string{"context", "steer"}
	got := mergeSessions([]Session{native}, []Session{hook, {Address: "shuttle://host/codex/other", Host: "host", Harness: "codex", ID: "other", State: "hook"}})
	if len(got) != 2 || got[0].State != "active" || got[0].LastSeen != 0 {
		t.Fatalf("native session did not win exact address: %#v", got)
	}
}

func TestMergeSessionsCollapsesRepeatedNativeAndHookAddresses(t *testing.T) {
	t.Parallel()
	native := Session{Address: "shuttle://host/claude/id", State: "idle"}
	hook := Session{Address: "shuttle://host/claude/other", State: "hook"}
	got := mergeSessions([]Session{native, native}, []Session{native, hook, hook})
	if len(got) != 2 || got[0].Address != native.Address || got[1].Address != hook.Address {
		t.Fatalf("discovery repeated a routable address: %#v", got)
	}
}

func TestClaudeDiscoveryKeepsHookRegistrationWhenNativeCLIUnavailable(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("PATH", t.TempDir())
	if err := RegisterMailbox(env, "claude", "session", "host", "/project", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	sessions, err := (claudeAdapter{}).discover(context.Background(), env, "host")
	if err == nil {
		t.Fatal("expected native Claude discovery gap")
	}
	if len(sessions) != 1 || sessions[0].State != "hook" || sessions[0].Harness != "claude" {
		t.Fatalf("registered Claude hook was lost: %#v", sessions)
	}
}
