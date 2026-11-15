package messaging

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

func threadRecord() map[string]any {
	return map[string]any{"owner": "host", "store": "/store", "parent_uid": "anchor", "parent_host": "host", "parent_unresolved": true, "anchor_uid": "anchor", "text": "thread hub/child closed: done", "retained_at": time.Now().UTC().Format(time.RFC3339Nano), "wake": true}
}

func bootThread(t *testing.T, env *sysenv.Env) ThreadImport {
	t.Helper()
	s, err := BootThreadInbox(env)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func capture(t *testing.T, env *sysenv.Env, publications ...ThreadPublication) []string {
	t.Helper()
	created, refused := CaptureThreads(env, publications)
	if len(refused) != 0 {
		t.Fatal(refused)
	}
	return created
}

func route(t *testing.T, env *sysenv.Env, f RouteFacts) RouteDecision {
	t.Helper()
	got, err := RouteThread(env, "host", f)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func routes(t *testing.T, env *sysenv.Env) []ThreadPublication {
	t.Helper()
	out, err := ThreadRoutes(env)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func offeredRoute(t *testing.T, env *sysenv.Env, id string) mailboxEntry {
	t.Helper()
	e, err := readFiberMailboxEntry(filepath.Join(routingRoot(env), "offered", mailboxKey(id)+".json"))
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func resolved(owner string) RouteFacts {
	return RouteFacts{Current: "true", Owner: owner, Key: "/store:parent", Record: map[string]any{"parent_uid": "parent", "parent_host": owner, "store": "/store", "resolved_from_uid": "anchor"}}
}

func TestThreadCaptureKeepsFirstPublicationInsideItsWindow(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	state := bootThread(t, env)
	record := threadRecord()
	if got := capture(t, env, ThreadPublication{"thread-a", record}); len(got) != 1 {
		t.Fatal(got)
	}
	edited := threadRecord()
	edited["text"] = "edited outcome"
	if got := capture(t, env, ThreadPublication{"thread-a", edited}); len(got) != 0 {
		t.Fatal("recapture created", got)
	}
	old := threadRecord()
	old["retained_at"] = state.Baseline
	if got := capture(t, env, ThreadPublication{"thread-history", old}); len(got) != 0 {
		t.Fatal("a stamp at the baseline was captured", got)
	}
	got := routes(t, env)
	if len(got) != 1 || got[0].ID != "thread-a" || got[0].Record["text"] != "thread hub/child closed: done" {
		t.Fatalf("%+v", got)
	}
	items, _ := pendingItems(routingRoot(env))
	if w := items[0].entry.Wishes; w.Turn != "ask" || w.IfCostly != "fresh" || w.Source != "thread" {
		t.Fatal(w)
	}
}

func TestRoutingInboxHasNoAdmissionCap(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	bootThread(t, env)
	var publications []ThreadPublication
	for i := 0; i < 200; i++ {
		publications = append(publications, ThreadPublication{fmt.Sprintf("thread-%d", i), threadRecord()})
	}
	if got := capture(t, env, publications...); len(got) != 200 {
		t.Fatal(len(got))
	}
}

func TestRouteForwardsAResolvedRemoteResultUntilSettled(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	bootThread(t, env)
	capture(t, env, ThreadPublication{"thread-f", threadRecord()})
	for _, f := range []RouteFacts{{ID: "thread-f", Current: "unknown"}, {ID: "thread-f", Current: "true"}} {
		if got := route(t, env, f); got.Action != "wait" {
			t.Fatal("unresolved", got)
		}
	}
	// The resolution is stored even while currency is unknown.
	f := resolved("remote")
	f.ID, f.Current = "thread-f", "unknown"
	if got := route(t, env, f); got.Action != "wait" {
		t.Fatal(got)
	}
	if r := routes(t, env)[0].Record; r["parent_uid"] != "parent" || r["parent_unresolved"] != nil || r["resolved_from_uid"] != "anchor" {
		t.Fatal(r)
	}
	f.Current = "true"
	for i := 0; i < 2; i++ {
		if got := route(t, env, f); got.Action != "forward" || got.Record["parent_uid"] != "parent" || got.Record["parent_host"] != "remote" {
			t.Fatal(got)
		}
	}
	redirect := f
	redirect.Record = map[string]any{"parent_uid": "other"}
	if _, err := RouteThread(env, "host", redirect); ErrorCode(err) != "invalid_request" {
		t.Fatal("a resolved recipient changed:", err)
	}
	if err := SettleThread(env, "thread-f", "forwarded"); err != nil {
		t.Fatal(err)
	}
	if offeredRoute(t, env, "thread-f").Disposition != "forwarded" || len(routes(t, env)) != 0 {
		t.Fatal("not settled")
	}
	if got := capture(t, env, ThreadPublication{"thread-f", threadRecord()}); len(got) != 0 {
		t.Fatal("a settled publication was captured again")
	}
}

func TestRoutePlacesALocalResultAsAnOrdinaryEntry(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	bootThread(t, env)
	capture(t, env, ThreadPublication{"thread-l", threadRecord()})
	f := resolved("host")
	f.ID = "thread-l"
	if got := route(t, env, f); got.Action != "placed" {
		t.Fatal(got)
	}
	items, err := pendingItems(mailboxDir(env, "fiber", "/store:parent"))
	if err != nil || len(items) != 1 {
		t.Fatal(items, err)
	}
	if e := items[0].entry; e.Routing != nil || e.Wishes.Turn != "ask" || e.Request.Text != "thread hub/child closed: done" {
		t.Fatalf("%+v", e)
	}
	if n, _ := WakingCount(env, "/store:parent"); n != 1 {
		t.Fatal("placed result does not ask its recipient", n)
	}
	if offeredRoute(t, env, "thread-l").Disposition != "placed" {
		t.Fatal("not settled")
	}
	if got := route(t, env, f); got.Action != "wait" {
		t.Fatal("repeat", got)
	}
}

func TestRouteIntoAFullRecipientWaitsWithoutLosingTheResult(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	bootThread(t, env)
	for i := 0; i < 128; i++ {
		if err := Enqueue(env, InboxEntry{Address: "/store:parent", Request: Request{MessageID: fmt.Sprintf("m-%d", i), Text: "x"}}); err != nil {
			t.Fatal(err)
		}
	}
	capture(t, env, ThreadPublication{"thread-full", threadRecord()})
	f := resolved("host")
	f.ID = "thread-full"
	if _, err := RouteThread(env, "host", f); ErrorCode(err) != "queue_full" {
		t.Fatal(err)
	}
	if got := routes(t, env); len(got) != 1 {
		t.Fatal(got)
	}
}

func TestRouteSettlesSupersededAndExpiredWithoutHandoff(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	bootThread(t, env)
	capture(t, env, ThreadPublication{"thread-s", threadRecord()})
	if got := route(t, env, RouteFacts{ID: "thread-s", Current: "false"}); got.Action != "superseded" {
		t.Fatal(got)
	}
	// An entry stored inside the window expires while it waits.
	capture(t, env, ThreadPublication{"thread-e", threadRecord()})
	path := filepath.Join(routingRoot(env), "pending", mailboxKey("thread-e")+".json")
	e, _ := readFiberMailboxEntry(path)
	e.Request.RetainedAt = time.Now().Add(-15 * 24 * time.Hour).UTC().Format(time.RFC3339Nano)
	b, _ := json.Marshal(e)
	os.WriteFile(path, b, 0600)
	if got := route(t, env, RouteFacts{ID: "thread-e", Current: "true"}); got.Action != "expired" {
		t.Fatal(got)
	}
}

func TestWaitingRouteDoesNotRewriteItsEntry(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	bootThread(t, env)
	capture(t, env, ThreadPublication{"thread-w", threadRecord()})
	f := resolved("remote")
	f.ID, f.Current = "thread-w", "unknown"
	route(t, env, f)
	path := filepath.Join(routingRoot(env), "pending", mailboxKey("thread-w")+".json")
	before, _ := os.Stat(path)
	time.Sleep(20 * time.Millisecond)
	route(t, env, f)
	after, _ := os.Stat(path)
	if !after.ModTime().Equal(before.ModTime()) {
		t.Fatal("rewritten while waiting")
	}
}

func TestAskerNoticeRoutesToItsSessionAndSettlesFinal(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	bootThread(t, env)
	record := map[string]any{"owner": "host", "store": "/store", "session": "shuttle://remote/claude/asker", "text": "thread hub/child asked: which?", "retained_at": time.Now().UTC().Format(time.RFC3339Nano)}
	capture(t, env, ThreadPublication{"thread-x-asker", record})
	if got := route(t, env, RouteFacts{ID: "thread-x-asker", Current: "unknown"}); got.Action != "wait" {
		t.Fatal(got)
	}
	for i := 0; i < 2; i++ {
		if got := route(t, env, RouteFacts{ID: "thread-x-asker", Current: "true"}); got.Action != "session" || got.Record["session"] != record["session"] {
			t.Fatal(got)
		}
	}
	if err := SettleThread(env, "thread-x-asker", "undeliverable"); err != nil {
		t.Fatal(err)
	}
	if offeredRoute(t, env, "thread-x-asker").Disposition != "undeliverable" || len(routes(t, env)) != 0 {
		t.Fatal("not settled")
	}
	if err := SettleThread(env, "thread-x-asker", "maybe"); ErrorCode(err) != "invalid_request" {
		t.Fatal(err)
	}
}

func seedOutbox(t *testing.T, env *sysenv.Env, baseline string) string {
	t.Helper()
	root := filepath.Join(dataDir(env), "thread-outbox")
	for _, dir := range []string{"pending", "acked"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	os.WriteFile(filepath.Join(root, "baseline"), []byte(baseline), 0600)
	os.WriteFile(filepath.Join(root, "version"), []byte("4"), 0600)
	return root
}

func seedPending(t *testing.T, root, id string, record map[string]any) {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"id": id, "record": record})
	if err := os.WriteFile(filepath.Join(root, "pending", mailboxKey(id)+".json"), b, 0600); err != nil {
		t.Fatal(err)
	}
}

func seedAck(t *testing.T, root, id string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(root, "acked", mailboxKey(id)), []byte(id), 0600); err != nil {
		t.Fatal(err)
	}
}

const oldBaseline = "2020-01-01T00:00:00Z"

func TestThreadImportCrashReplayAckWinsAndBaselineSurvives(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	root := seedOutbox(t, env, oldBaseline)
	record := threadRecord()
	seedPending(t, root, "thread-pending", record)
	seedPending(t, root, "thread-acked", record)
	seedAck(t, root, "thread-acked")
	stopped := errors.New("daemon died")
	if _, err := bootThreadInbox(env, func(string) error { return stopped }); !errors.Is(err, stopped) {
		t.Fatal(err)
	}
	if _, err := os.Stat(root); err != nil {
		t.Fatal("source removed before the import completed", err)
	}
	state := bootThread(t, env)
	if state.Baseline != oldBaseline {
		t.Fatal(state)
	}
	if _, err := os.Stat(root); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("source remains: %v", err)
	}
	if got := routes(t, env); len(got) != 1 || got[0].ID != "thread-pending" {
		t.Fatalf("%+v", got)
	}
	if offeredRoute(t, env, "thread-acked").Disposition != "acknowledged" {
		t.Fatal("acknowledgment not imported")
	}
	if got := capture(t, env, ThreadPublication{"thread-acked", record}); len(got) != 0 {
		t.Fatal("an acknowledged publication was captured again")
	}
	if got := bootThread(t, env); got.Baseline != oldBaseline {
		t.Fatal(got)
	}
}

func TestThreadImportAckWinsOverACopyFromAnInterruptedImport(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	root := seedOutbox(t, env, oldBaseline)
	seedPending(t, root, "thread-late", threadRecord())
	stopped := errors.New("death after the pending write")
	if _, err := bootThreadInbox(env, func(string) error { return stopped }); !errors.Is(err, stopped) {
		t.Fatal(err)
	}
	if len(routes(t, env)) != 1 {
		t.Fatal("pending not durable")
	}
	seedAck(t, root, "thread-late")
	bootThread(t, env)
	if got := routes(t, env); len(got) != 0 {
		t.Fatalf("acknowledgment lost: %+v", got)
	}
}

func TestThreadImportLeavesRecipientInboxesAlone(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	root := seedOutbox(t, env, oldBaseline)
	// Contract 40 placed this result and acknowledged it before a worker took it.
	if err := Enqueue(env, InboxEntry{Address: "/store:parent", Request: Request{MessageID: "thread-done", Text: "already placed"}, Derived: true}); err != nil {
		t.Fatal(err)
	}
	seedPending(t, root, "thread-done", threadRecord())
	seedAck(t, root, "thread-done")
	bootThread(t, env)
	if n, err := PendingCount(env, "/store:parent"); err != nil || n != 1 {
		t.Fatalf("recipient's result disturbed: %d %v", n, err)
	}
}

func TestThreadImportRefusesCorruptSourceAndKeepsIt(t *testing.T) {
	t.Parallel()
	for _, corrupt := range []string{"baseline", "pending", "snapshot", "missing baseline", "cutoff"} {
		t.Run(corrupt, func(t *testing.T) {
			env := testEnv(t)
			root := seedOutbox(t, env, oldBaseline)
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
			if _, err := BootThreadInbox(env); ErrorCode(err) != "corrupt" {
				t.Fatal("corrupt source accepted:", err)
			}
			if _, err := os.Stat(root); err != nil {
				t.Fatal("corrupt source removed")
			}
		})
	}
}

// The old daemon wrote acked/<key>.<n>.tmp and renamed it; a hard kill
// between the two left the tmp file, which was never an acknowledgment.
func TestThreadImportIgnoresALeftoverAckTmpFile(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	root := seedOutbox(t, env, oldBaseline)
	seedAck(t, root, "thread-acked")
	os.WriteFile(filepath.Join(root, "acked", mailboxKey("thread-acked")+".123.tmp"), []byte("thread-acked"), 0600)
	os.WriteFile(filepath.Join(root, "acked", mailboxKey("thread-torn")+".456.tmp"), []byte("thread-to"), 0600)
	bootThread(t, env)
	if offeredRoute(t, env, "thread-acked").Disposition != "acknowledged" {
		t.Fatal("acknowledgment lost")
	}
	if _, err := os.Stat(filepath.Join(routingRoot(env), "offered", mailboxKey("thread-torn")+".json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a torn tmp file was imported", err)
	}
}

// A pending record the routing inbox can never accept (the old outbox stored
// any text) is skipped and reported; the rest import.
func TestThreadImportSkipsARecordTheInboxCanNeverAccept(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	root := seedOutbox(t, env, oldBaseline)
	big := threadRecord()
	big["text"] = "thread hub/child closed: " + strings.Repeat("x", 65<<10)
	seedPending(t, root, "thread-big", big)
	seedPending(t, root, "thread-ok", threadRecord())
	report := bootThread(t, env)
	if len(report.Skipped) != 1 || report.Skipped[0].ID != "thread-big" || !strings.Contains(report.Skipped[0].Error, "64 KiB") {
		t.Fatalf("%+v", report)
	}
	if got := routes(t, env); len(got) != 1 || got[0].ID != "thread-ok" {
		t.Fatalf("%+v", got)
	}
	if _, err := os.Stat(root); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("source remains", err)
	}
}

// An acknowledgment is its file name: the old daemon tolerated an ack it
// could not read (Fir's Lustre client could not stat one), and so does the
// import. Any other name in acked/ was never an acknowledgment.
func TestThreadImportTakesAcknowledgmentsByNameAlone(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	root := seedOutbox(t, env, oldBaseline)
	seedPending(t, root, "thread-acked", threadRecord())
	seedAck(t, root, "thread-acked")
	unreadable := filepath.Join(root, "acked", mailboxKey("thread-acked"))
	if err := os.Chmod(unreadable, 0); err != nil {
		t.Fatal(err)
	}
	seedAck(t, root, "thread-mismatched")
	os.WriteFile(filepath.Join(root, "acked", mailboxKey("thread-mismatched")), []byte("other content"), 0600)
	for _, stray := range []string{".nfs000000000123", ".DS_Store", "notes.txt"} {
		os.WriteFile(filepath.Join(root, "acked", stray), []byte("thread-acked"), 0600)
	}
	if report := bootThread(t, env); report.Cleanup != "" {
		t.Fatal(report)
	}
	if got := routes(t, env); len(got) != 0 {
		t.Fatalf("the acknowledgment did not win: %+v", got)
	}
	for _, id := range []string{"thread-acked", "thread-mismatched"} {
		if offeredRoute(t, env, id).Disposition != "acknowledged" {
			t.Fatal(id)
		}
	}
	offered, _ := os.ReadDir(filepath.Join(routingRoot(env), "offered"))
	if len(offered) != 2 {
		t.Fatalf("stray names were imported: %v", offered)
	}
}

// A complete import whose cleanup cannot remove the source reports it and
// boots; later boots do too, and import nothing again.
func TestThreadImportCleanupFailureIsReportedNotHeld(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	root := seedOutbox(t, env, oldBaseline)
	seedAck(t, root, "thread-a")
	acked := filepath.Join(root, "acked")
	if err := os.Chmod(acked, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(filepath.Join(root+".imported", "acked"), 0700) })
	for i := 0; i < 3; i++ {
		report, err := BootThreadInbox(env)
		if err != nil || report.Baseline != oldBaseline || report.Cleanup == "" {
			t.Fatalf("boot %d: %+v %v", i, report, err)
		}
	}
	if offeredRoute(t, env, "thread-a").Disposition != "acknowledged" {
		t.Fatal("ack not imported")
	}
	if _, err := os.Stat(root); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the imported source would import again", err)
	}
	os.Chmod(filepath.Join(root+".imported", "acked"), 0700)
	if report := bootThread(t, env); report.Cleanup != "" {
		t.Fatal(report)
	}
	if _, err := os.Stat(root + ".imported"); !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
}

// A daemon rolled back to contract 40 recreates thread-outbox with a later
// baseline. Rolling forward keeps the inbox's earlier one and imports what the
// older daemon captured; its acknowledgment settles the inbox's copy.
func TestThreadImportRollForwardAfterRollbackKeepsTheEarlierBaseline(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	seedOutbox(t, env, oldBaseline)
	first := bootThread(t, env)
	capture(t, env, ThreadPublication{"thread-both", threadRecord()}, ThreadPublication{"thread-new", threadRecord()})
	later := time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)
	root := seedOutbox(t, env, later)
	seedAck(t, root, "thread-both")
	seedPending(t, root, "thread-old", threadRecord())
	state, err := BootThreadInbox(env)
	if err != nil || state.Baseline != first.Baseline {
		t.Fatal(state, err)
	}
	ids := map[string]bool{}
	for _, p := range routes(t, env) {
		ids[p.ID] = true
	}
	if len(ids) != 2 || !ids["thread-new"] || !ids["thread-old"] {
		t.Fatal(ids)
	}
}

func TestThreadImportCutoffAdvancesAndRefusesOlderCaptures(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	root := seedOutbox(t, env, oldBaseline)
	cutoff := time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)
	os.WriteFile(filepath.Join(root, "retention_cutoff"), []byte(cutoff), 0600)
	bootThread(t, env)
	if s, err := ReadThreadInboxState(env); err != nil || s.Cutoff != cutoff {
		t.Fatal(s, err)
	}
	if got := capture(t, env, ThreadPublication{"thread-before-cutoff", threadRecord()}); len(got) != 0 {
		t.Fatal(got)
	}
}

func TestThreadImportBacklogInterruptedCleanupAndSnapshot(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	root := seedOutbox(t, env, oldBaseline)
	for i := 0; i < 140; i++ {
		seedPending(t, root, fmt.Sprintf("thread-%d", i), threadRecord())
	}
	state := bootThread(t, env)
	if got := routes(t, env); len(got) != 140 {
		t.Fatal(len(got))
	}
	// Recursive deletion was interrupted after the completed source was renamed.
	os.MkdirAll(root+".imported/pending", 0700)
	os.WriteFile(filepath.Join(root+".imported", "pending", "partial"), []byte("partial"), 0600)
	if got := bootThread(t, env); got.Baseline != state.Baseline {
		t.Fatal(got)
	}
	if _, err := os.Stat(root + ".imported"); !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}

	env = testEnv(t)
	record := threadRecord()
	record["parent"] = map[string]any{"uid": "parent"}
	delete(record, "parent_uid")
	b, _ := json.Marshal(map[string]any{"version": 2, "baseline": oldBaseline, "records": map[string]any{"thread-p": record, "thread-a": map[string]any{"acked": true}}})
	os.WriteFile(filepath.Join(dataDir(env), "thread-outbox.json"), b, 0600)
	if s := bootThread(t, env); s.Baseline != oldBaseline {
		t.Fatal(s)
	}
	if got := routes(t, env); len(got) != 1 || got[0].Record["parent_uid"] != "parent" {
		t.Fatalf("%+v", got)
	}
}

func TestFreshThreadInboxEstablishesItsBaselineOnce(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	before := time.Now()
	state := bootThread(t, env)
	baseline, err := time.Parse(time.RFC3339Nano, state.Baseline)
	if err != nil || baseline.Before(before) {
		t.Fatal(state, err)
	}
	if bootThread(t, env).Baseline != state.Baseline {
		t.Fatal("baseline reset")
	}
}

// The import touches only the outbox and the routing inbox, so a host's
// other inboxes cost it nothing. This tree has a busy laptop's shape.
func TestThreadImportTimeDoesNotGrowWithTheMailboxTree(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	for harness, n := range map[string]int{"claude": 931, "pi": 1496, "codex": 95, "fiber": 217} {
		for i := 0; i < n; i++ {
			if err := os.MkdirAll(filepath.Join(dataDir(env), "mailboxes", harness, fmt.Sprintf("s%d", i), "pending"), 0700); err != nil {
				t.Fatal(err)
			}
		}
	}
	root := seedOutbox(t, env, oldBaseline)
	for i := 0; i < 236; i++ {
		seedAck(t, root, fmt.Sprintf("thread-ack-%d", i))
	}
	for i := 0; i < 9; i++ {
		seedPending(t, root, fmt.Sprintf("thread-pending-%d", i), threadRecord())
	}
	start := time.Now()
	bootThread(t, env)
	elapsed := time.Since(start)
	t.Logf("import of 236 acknowledgments and 9 results: %v", elapsed)
	if elapsed > 10*time.Second {
		t.Fatalf("import took %v; the daemon's timeout is 60s", elapsed)
	}
}
