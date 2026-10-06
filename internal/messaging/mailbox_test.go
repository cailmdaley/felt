package messaging

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
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
	if err := RegisterMailbox(env, "codex", "thread/1", "owner", "/project", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	if MailboxAvailable(env, "codex", "thread/1", "other") {
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
	wrongHost.Address = "shuttle://other/codex/thread%2F1"
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
