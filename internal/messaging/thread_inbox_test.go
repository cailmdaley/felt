package messaging

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

func threadRecord() map[string]any {
	return map[string]any{"owner": "host", "store": "/store", "parent_uid": "parent", "parent_host": "host", "parent_unresolved": true, "text": "thread hub/child unblocked: done", "retained_at": time.Now().UTC().Format(time.RFC3339Nano), "wake": true}
}
func enqueueThread(t *testing.T, env *sysenv.Env, id string, record map[string]any) InboxEntry {
	t.Helper()
	entry, err := ThreadEntry(id, record)
	if err != nil {
		t.Fatal(err)
	}
	if err = Enqueue(env, entry); err != nil {
		t.Fatal(err)
	}
	return entry
}
func bootThread(t *testing.T, env *sysenv.Env) ThreadInboxState {
	t.Helper()
	s, err := BootThreadInbox(env)
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func routeConsume(t *testing.T, env *sysenv.Env, entry InboxEntry, f RouteFacts) Consumption {
	t.Helper()
	f.ID = entry.Request.MessageID
	got, err := Consume(context.Background(), env, entry.Address, "host", Worker{Address: "-", Route: &f})
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestThreadCaptureCreatedFirstPublicationAndGlobalDedup(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	bootThread(t, env)
	entry, _ := ThreadEntry("thread-id", threadRecord())
	created := false
	entry.Created = &created
	if err := Enqueue(env, entry); err != nil || !created {
		t.Fatalf("capture: %v %v", created, err)
	}
	entry.Request.Text = "edited outcome"
	entry.Address = "/other:other-parent"
	if err := Enqueue(env, entry); err != nil || created {
		t.Fatalf("recapture: %v %v", created, err)
	}
	routes, err := RoutedEntries(env, "host")
	if err != nil || len(routes) != 1 || routes[0].Record["text"] != "thread hub/child unblocked: done" {
		t.Fatalf("routes: %+v %v", routes, err)
	}
}

func TestThreadRoutingWaitForwardRetryConfirmAndFrozenRecipient(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	bootThread(t, env)
	record := threadRecord()
	entry := enqueueThread(t, env, "thread-forward", record)
	if got := routeConsume(t, env, entry, RouteFacts{Current: "unknown"}); got.Action != "wait" {
		t.Fatal(got)
	}
	if got := routeConsume(t, env, entry, RouteFacts{Current: "true"}); got.Action != "wait" {
		t.Fatal(got)
	}
	facts := RouteFacts{Current: "true", Record: map[string]any{"parent_uid": "ancestor", "parent_host": "remote", "store": "/remote"}, Owner: "remote"}
	for i := 0; i < 2; i++ {
		got := routeConsume(t, env, entry, facts)
		if got.Action != "forward" || got.Entry.Record["parent_uid"] != "ancestor" {
			t.Fatal(got)
		}
	}
	routes, err := RoutedEntries(env, "host")
	if err != nil || len(routes) != 1 || routes[0].Address != entry.Address {
		t.Fatalf("frozen physical address: %+v %v", routes, err)
	}
	changed := facts
	changed.Record = map[string]any{"parent_uid": "other"}
	changed.ID = entry.Request.MessageID
	if _, err = Consume(context.Background(), env, entry.Address, "host", Worker{Route: &changed}); ErrorCode(err) != "invalid_request" {
		t.Fatalf("redirect: %v", err)
	}
	if err = SettleRoute(env, entry.Address, entry.Request.MessageID, "forwarded"); err != nil {
		t.Fatal(err)
	}
	if got := routeConsume(t, env, entry, facts); got.Action != "wait" {
		t.Fatal(got)
	}
	enqueueThread(t, env, entry.Request.MessageID, record)
	if n, _ := PendingCount(env, entry.Address); n != 0 {
		t.Fatal(n)
	}
}

func TestThreadRoutingLocalTransferAndSupersession(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	bootThread(t, env)
	for _, dest := range []string{"/store:parent", "/store:ancestor"} {
		entry := enqueueThread(t, env, "thread-"+mailboxKey(dest), threadRecord())
		facts := RouteFacts{Current: "true", Owner: "host", Destination: dest, Record: map[string]any{"parent_uid": "parent"}}
		if dest != "/store:parent" {
			facts.Record["parent_uid"] = "ancestor"
		}
		routeConsume(t, env, entry, facts)
		items, err := pendingItems(mailboxDir(env, "fiber", dest))
		if err != nil || len(items) != 1 || items[0].entry.Routing != nil {
			t.Fatalf("local: %+v %v", items, err)
		}
	}
	entry := enqueueThread(t, env, "thread-stale", threadRecord())
	routeConsume(t, env, entry, RouteFacts{Current: "false"})
	root := mailboxDir(env, "fiber", entry.Address)
	stored, err := readFiberMailboxEntry(filepath.Join(root, "offered", mailboxKey(entry.Request.MessageID)+".json"))
	if err != nil || stored.Disposition != "superseded" {
		t.Fatalf("superseded: %+v %v", stored, err)
	}
}

func TestThreadAskerIsDurableSessionEntryNotHookEligible(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	bootThread(t, env)
	record := threadRecord()
	record["session"] = "shuttle://host/claude/asker"
	entry := enqueueThread(t, env, "thread-id-asker", record)
	if entry.Address != record["session"] {
		t.Fatal(entry)
	}
	// A live hook cannot race the daemon's waking notice.
	if err := RegisterMailbox(env, "claude", "asker", "host", "/project", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	if err := OfferMailbox(env, "claude", "asker", "host", func([]Request) error { t.Fatal("routed notice offered by hook"); return nil }); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if got := routeConsume(t, env, entry, RouteFacts{Current: "true"}); got.Action != "session" {
			t.Fatal(got)
		}
	}
	if err := SettleRoute(env, entry.Address, entry.Request.MessageID, "undeliverable"); err != nil {
		t.Fatal(err)
	}
	if routes, _ := RoutedEntries(env, "host"); len(routes) != 0 {
		t.Fatal(routes)
	}
}

func seedOutbox(t *testing.T, env *sysenv.Env) string {
	t.Helper()
	root := filepath.Join(dataDir(env), "thread-outbox")
	for _, dir := range []string{"pending", "acked"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "baseline"), []byte("2020-01-01T00:00:00Z"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "version"), []byte("4"), 0600); err != nil {
		t.Fatal(err)
	}
	return root
}
func seedPending(t *testing.T, root, id string, record map[string]any) {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"id": id, "record": record})
	if err := os.WriteFile(filepath.Join(root, "pending", mailboxKey(id)+".json"), b, 0600); err != nil {
		t.Fatal(err)
	}
}
func TestThreadBootImportCrashReplayAckWinsAndBaselineSurvives(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	root := seedOutbox(t, env)
	record := threadRecord()
	record["parent_unresolved"] = false
	record["parent_host"] = "remote"
	seedPending(t, root, "pending", record)
	seedPending(t, root, "acked", record)
	if err := os.WriteFile(filepath.Join(root, "acked", mailboxKey("acked")), []byte("acked"), 0600); err != nil {
		t.Fatal(err)
	}
	stopped := errors.New("daemon died")
	if _, err := bootThreadInbox(env, func(string) error { return stopped }); !errors.Is(err, stopped) {
		t.Fatal(err)
	}
	if _, err := os.Stat(root); err != nil {
		t.Fatal("source removed before complete import", err)
	}
	state := bootThread(t, env)
	if state.Baseline != "2020-01-01T00:00:00Z" {
		t.Fatal(state)
	}
	if _, err := os.Stat(root); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("source remains: %v", err)
	}
	routes, err := RoutedEntries(env, "host")
	if err != nil || len(routes) != 1 || routes[0].ID != "pending" || routes[0].Record["parent_host"] != "remote" {
		t.Fatalf("import: %+v %v", routes, err)
	}
	enqueueThread(t, env, "acked", record)
	if routes, _ := RoutedEntries(env, "host"); len(routes) != 1 {
		t.Fatal(routes)
	}
	if got := bootThread(t, env); got.Baseline != state.Baseline {
		t.Fatal(got)
	}
}
func TestThreadImportPreservesCutoffAndCorruptSource(t *testing.T) {
	t.Parallel()
	for _, corrupt := range []string{"baseline", "pending", "snapshot", "missing baseline", "cutoff"} {
		t.Run(corrupt, func(t *testing.T) {
			env := testEnv(t)
			root := seedOutbox(t, env)
			switch corrupt {
			case "baseline":
				os.WriteFile(filepath.Join(root, "baseline"), []byte("bad"), 0600)
			case "pending":
				os.WriteFile(filepath.Join(root, "pending", "bad.json"), []byte("{"), 0600)
			case "snapshot":
				os.WriteFile(root+".json", []byte("{"), 0600)
			case "missing baseline":
				os.Remove(filepath.Join(root, "baseline"))
			case "cutoff":
				os.WriteFile(filepath.Join(root, "retention_cutoff"), []byte("bad"), 0600)
			}
			if _, err := BootThreadInbox(env); err == nil {
				t.Fatal("corrupt source accepted")
			}
			if _, err := os.Stat(root); err != nil {
				t.Fatal("corrupt source removed")
			}
		})
	}
	env := testEnv(t)
	root := seedOutbox(t, env)
	cutoff := time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)
	os.WriteFile(filepath.Join(root, "retention_cutoff"), []byte(cutoff), 0600)
	if s := bootThread(t, env); s.Cutoff != cutoff {
		t.Fatal(s)
	}
	enqueueThread(t, env, "expired", threadRecord())
	if routes, _ := RoutedEntries(env, "host"); len(routes) != 0 {
		t.Fatal(routes)
	}
}
func TestThreadImportSessionHandoffDisclosesPossibleRepeat(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	root := seedOutbox(t, env)
	record := threadRecord()
	record["session"] = "shuttle://remote/claude/asker"
	seedPending(t, root, "thread-result-asker", record)
	bootThread(t, env)
	routes, err := RoutedEntries(env, "host")
	if err != nil || len(routes) != 1 || routes[0].Address != record["session"] || routes[0].Record["possible_repeat"] != true {
		t.Fatalf("imported session: %+v %v", routes, err)
	}
}

func TestThreadImportPendingWriteCrashThenAcknowledgmentWins(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	root := seedOutbox(t, env)
	seedPending(t, root, "acked", threadRecord())
	stopped := errors.New("death after pending write")
	if _, err := bootThreadInbox(env, func(string) error { return stopped }); !errors.Is(err, stopped) {
		t.Fatal(err)
	}
	if routes, err := RoutedEntries(env, "host"); err != nil || len(routes) != 1 {
		t.Fatalf("pending not durable: %+v %v", routes, err)
	}
	os.WriteFile(filepath.Join(root, "acked", mailboxKey("acked")), []byte("acked"), 0600)
	bootThread(t, env)
	if routes, err := RoutedEntries(env, "host"); err != nil || len(routes) != 0 {
		t.Fatalf("ack lost: %+v %v", routes, err)
	}
	enqueueThread(t, env, "acked", threadRecord())
	if routes, _ := RoutedEntries(env, "host"); len(routes) != 0 {
		t.Fatal(routes)
	}
}

func TestThreadImportKeepsAlreadyEnqueuedAcknowledgedResult(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	root := seedOutbox(t, env)
	// Contract 40 acknowledged this inbox entry before its worker took it.
	if err := Enqueue(env, InboxEntry{Address: "/store:parent", Request: Request{MessageID: "acked", Text: "already enqueued"}, Derived: true}); err != nil {
		t.Fatal(err)
	}
	seedPending(t, root, "acked", threadRecord())
	os.WriteFile(filepath.Join(root, "acked", mailboxKey("acked")), []byte("acked"), 0600)
	bootThread(t, env)
	if n, err := PendingCount(env, "/store:parent"); err != nil || n != 1 {
		t.Fatalf("ack destroyed recipient's pending result: %d %v", n, err)
	}
}

func TestThreadImportAcceptsLargeBacklogAndInterruptedCleanup(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	root := seedOutbox(t, env)
	record := threadRecord()
	for i := 0; i < 140; i++ {
		seedPending(t, root, time.Unix(int64(i), 0).String(), record)
	}
	state := bootThread(t, env)
	if routes, err := RoutedEntries(env, "host"); err != nil || len(routes) != 140 {
		t.Fatalf("backlog: %d %v", len(routes), err)
	}
	// Recursive deletion was interrupted after the completed source was renamed.
	if err := os.MkdirAll(root+".imported/pending", 0700); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(root+".imported", "pending", "partial"), []byte("partial"), 0600)
	if got := bootThread(t, env); got.Baseline != state.Baseline {
		t.Fatal(got)
	}
	if _, err := os.Stat(root + ".imported"); !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
}

func TestFreshThreadInboxBaselineAndSnapshotImport(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	before := time.Now()
	state := bootThread(t, env)
	baseline, err := time.Parse(time.RFC3339Nano, state.Baseline)
	if err != nil || baseline.Before(before) {
		t.Fatal(state, err)
	}
	if state.Baseline != bootThread(t, env).Baseline {
		t.Fatal("baseline reset")
	}
	env = testEnv(t)
	record := threadRecord()
	record["parent"] = map[string]any{"uid": "parent"}
	delete(record, "parent_uid")
	b, _ := json.Marshal(map[string]any{"version": 2, "baseline": "2020-01-01T00:00:00Z", "records": map[string]any{"pending": record, "acked": map[string]any{"acked": true}}})
	os.WriteFile(filepath.Join(dataDir(env), "thread-outbox.json"), b, 0600)
	bootThread(t, env)
	routes, err := RoutedEntries(env, "host")
	if err != nil || len(routes) != 1 || routes[0].Record["parent_uid"] != "parent" {
		t.Fatalf("snapshot: %+v %v", routes, err)
	}
}
