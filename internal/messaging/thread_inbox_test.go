package messaging

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

func threadRecord() map[string]any {
	return map[string]any{"owner": "host", "store": "/store", "parent_uid": "anchor", "parent_host": "host", "parent_unresolved": true, "anchor_uid": "anchor", "text": "thread hub/child closed: done", "retained_at": time.Now().UTC().Format(time.RFC3339Nano), "wake": true}
}

func bootThread(t *testing.T, env *sysenv.Env) ThreadInboxState {
	t.Helper()
	s, err := BootThreadInbox(env)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func capture(t *testing.T, env *sysenv.Env, publications ...ThreadPublication) []string {
	t.Helper()
	c := CaptureThreads(env, publications)
	if len(c.Refused) != 0 {
		t.Fatal(c.Refused)
	}
	return c.Created
}

func route(t *testing.T, env *sysenv.Env, f RouteFacts) RouteDecision {
	t.Helper()
	got, err := RouteThread(env, f)
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

func pendingRoute(t *testing.T, env *sysenv.Env, id string) mailboxEntry {
	t.Helper()
	e, err := readFiberMailboxEntry(filepath.Join(routingRoot(env), "pending", mailboxKey(id)+".json"))
	if err != nil {
		t.Fatal(err)
	}
	return e
}

// resolved is a resolved recipient on owner; this test host is "host".
func resolved(owner string) RouteFacts {
	f := RouteFacts{Current: "true", Record: map[string]any{"parent_uid": "parent", "parent_host": owner, "store": "/store", "resolved_from_uid": "anchor"}}
	if owner == "host" {
		f.Key = "/store:parent"
	}
	return f
}

func TestThreadCaptureKeepsFirstPublicationInsideItsWindow(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	state := bootThread(t, env)
	record := threadRecord()
	if got := capture(t, env, ThreadPublication{ID: "thread-a", Record: record}); len(got) != 1 {
		t.Fatal(got)
	}
	edited := threadRecord()
	edited["text"] = "edited outcome"
	if got := capture(t, env, ThreadPublication{ID: "thread-a", Record: edited}); len(got) != 0 {
		t.Fatal("recapture created", got)
	}
	old := threadRecord()
	old["retained_at"] = state.Baseline
	if got := capture(t, env, ThreadPublication{ID: "thread-history", Record: old}); len(got) != 0 {
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

// Capture reads stamps in every form the daemon's capture accepts and keeps
// them as written; an unreadable or expired stamp stores nothing.
func TestThreadCaptureReadsElixirStampsAsWritten(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	if err := os.MkdirAll(filepath.Dir(threadStatePath(env)), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(threadStatePath(env), []byte(`{"baseline":"2020-01-01T00:00:00Z"}`), 0600); err != nil {
		t.Fatal(err)
	}
	hourAgo := time.Now().Add(-time.Hour)
	stamps := map[string]string{
		"thread-space":   hourAgo.UTC().Format("2006-01-02 15:04:05Z"),
		"thread-offset":  hourAgo.In(time.FixedZone("", 3600)).Format("2006-01-02T15:04:05.000-0700"),
		"thread-hours":   hourAgo.In(time.FixedZone("", -7200)).Format("2006-01-02T15:04:05-07"),
		"thread-comma":   hourAgo.UTC().Format("2006-01-02T15:04:05") + ",25Z",
		"thread-garbage": "yesterday",
		"thread-old":     time.Now().Add(-15 * 24 * time.Hour).UTC().Format("2006-01-02 15:04:05Z"),
	}
	for id, stamp := range stamps {
		r := threadRecord()
		r["retained_at"] = stamp
		capture(t, env, ThreadPublication{ID: id, Record: r})
	}
	got := map[string]string{}
	for _, p := range routes(t, env) {
		got[p.ID] = p.Record["retained_at"].(string)
	}
	for _, id := range []string{"thread-space", "thread-offset", "thread-hours", "thread-comma"} {
		if got[id] != stamps[id] {
			t.Fatalf("%s: %q, want %q as written", id, got[id], stamps[id])
		}
	}
	if len(got) != 4 {
		t.Fatalf("an unreadable or expired stamp was captured: %v", got)
	}
}

func TestRoutingInboxHasNoAdmissionCap(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	bootThread(t, env)
	var publications []ThreadPublication
	for i := 0; i < 200; i++ {
		publications = append(publications, ThreadPublication{ID: fmt.Sprintf("thread-%d", i), Record: threadRecord()})
	}
	if got := capture(t, env, publications...); len(got) != 200 {
		t.Fatal(len(got))
	}
}

func TestRouteForwardsAResolvedRemoteResultUntilSettled(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	bootThread(t, env)
	capture(t, env, ThreadPublication{ID: "thread-f", Record: threadRecord()})
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
	if _, err := RouteThread(env, redirect); ErrorCode(err) != "invalid_request" {
		t.Fatal("a resolved recipient changed:", err)
	}
	if err := SettleThread(env, "thread-f", "forwarded"); err != nil {
		t.Fatal(err)
	}
	if offeredRoute(t, env, "thread-f").Disposition != "forwarded" || len(routes(t, env)) != 0 {
		t.Fatal("not settled")
	}
	if got := capture(t, env, ThreadPublication{ID: "thread-f", Record: threadRecord()}); len(got) != 0 {
		t.Fatal("a settled publication was captured again")
	}
}

func TestRoutePlacesALocalResultAsAnOrdinaryEntry(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	bootThread(t, env)
	capture(t, env, ThreadPublication{ID: "thread-l", Record: threadRecord()})
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

// The asking fiber's worker asked, and the recipient resolved past that fiber
// (it was archived). The orchestrator takes the result quietly, locally or
// forwarded, and the asking session gets the waking notice. A recipient that
// resolves to the asking fiber keeps the wake.
func TestRouteResolvedPastTheAskingFiberWakesTheAskingSession(t *testing.T) {
	t.Parallel()
	for _, owner := range []string{"host", "peer"} {
		env := testEnv(t)
		bootThread(t, env)
		r := threadRecord()
		r["asked_by"] = map[string]any{"session": "shuttle://host/claude/asker", "fiber": "anchor"}
		r["signal"] = map[string]any{"uid": "child", "verb": "closed", "stamp": r["retained_at"], "owner": "host"}
		capture(t, env, ThreadPublication{ID: "thread-a", Record: r})
		f := resolved(owner)
		f.ID = "thread-a"
		// A forward repeats until settled, and the repeat carries the stored
		// quiet wish.
		want := map[string][]string{"host": {"placed", "wait"}, "peer": {"forward", "forward"}}[owner]
		for _, action := range want {
			got := route(t, env, f)
			if got.Action != action || (action == "forward" && got.Record["wake"] != false) {
				t.Fatal(owner, got)
			}
		}
		if owner == "host" {
			if n, _ := WakingCount(env, "/store:parent"); n != 0 {
				t.Fatal("the orchestrator was asked for a turn", n)
			}
		}
		notice := pendingRoute(t, env, "thread-a-asker")
		if notice.Routing["session"] != "shuttle://host/claude/asker" || notice.Wishes.Turn != "ask" || notice.Request.Text != r["text"] || notice.Request.ThreadSignal == nil || notice.Routing["store"] != "/store" {
			t.Fatalf("%s %+v", owner, notice)
		}
		if got := route(t, env, RouteFacts{ID: "thread-a-asker", Current: "true"}); got.Action != "session" {
			t.Fatal(got)
		}
	}
	env := testEnv(t)
	bootThread(t, env)
	r := threadRecord()
	r["asked_by"] = map[string]any{"session": "shuttle://host/claude/asker", "fiber": "parent"}
	capture(t, env, ThreadPublication{ID: "thread-b", Record: r})
	f := resolved("host")
	f.ID = "thread-b"
	if got := route(t, env, f); got.Action != "placed" {
		t.Fatal(got)
	}
	if n, _ := WakingCount(env, "/store:parent"); n != 1 || len(routes(t, env)) != 0 {
		t.Fatal("the asking orchestrator lost its wake", n)
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
	capture(t, env, ThreadPublication{ID: "thread-full", Record: threadRecord()})
	f := resolved("host")
	f.ID = "thread-full"
	if _, err := RouteThread(env, f); ErrorCode(err) != "queue_full" {
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
	capture(t, env, ThreadPublication{ID: "thread-s", Record: threadRecord()})
	if got := route(t, env, RouteFacts{ID: "thread-s", Current: "false"}); got.Action != "superseded" {
		t.Fatal(got)
	}
	// An entry stored inside the window expires while it waits.
	capture(t, env, ThreadPublication{ID: "thread-e", Record: threadRecord()})
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
	capture(t, env, ThreadPublication{ID: "thread-w", Record: threadRecord()})
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
	capture(t, env, ThreadPublication{ID: "thread-x-asker", Record: record})
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

// The state holds the baseline alone, which a boot keeps: other fields are
// ignored, and the 14-day window on the stamp refuses what has expired.
func TestThreadInboxStateIsTheBaselineAlone(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	const baseline = "2020-01-01T00:00:00Z"
	if err := os.MkdirAll(filepath.Dir(threadStatePath(env)), 0700); err != nil {
		t.Fatal(err)
	}
	state := `{"baseline":"` + baseline + `","retention_cutoff":"2999-01-01T00:00:00Z"}`
	if err := os.WriteFile(threadStatePath(env), []byte(state), 0600); err != nil {
		t.Fatal(err)
	}
	if got := bootThread(t, env); got.Baseline != baseline {
		t.Fatal(got)
	}
	if got := capture(t, env, ThreadPublication{ID: "thread-recent", Record: threadRecord()}); len(got) != 1 {
		t.Fatal("a recent stamp was refused", got)
	}
	expired := threadRecord()
	expired["retained_at"] = time.Now().Add(-15 * 24 * time.Hour).UTC().Format(time.RFC3339Nano)
	if got := capture(t, env, ThreadPublication{ID: "thread-expired", Record: expired}); len(got) != 0 {
		t.Fatal("an expired stamp was captured", got)
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

// A malformed state is never replaced: boot refuses it as corrupt and leaves
// it for the operator to restore.
func TestThreadInboxRefusesACorruptStateAndKeepsIt(t *testing.T) {
	t.Parallel()
	for name, state := range map[string]string{"json": "{", "baseline": `{"baseline":"not a time"}`} {
		t.Run(name, func(t *testing.T) {
			env := testEnv(t)
			if err := os.MkdirAll(filepath.Dir(threadStatePath(env)), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(threadStatePath(env), []byte(state), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := BootThreadInbox(env); ErrorCode(err) != "corrupt" {
				t.Fatal("corrupt state accepted:", err)
			}
			if b, _ := os.ReadFile(threadStatePath(env)); string(b) != state {
				t.Fatal("corrupt state replaced:", string(b))
			}
		})
	}
}

// An owed board line lives in its entry: recording the append keeps the
// offered entry's retention clock, and an obligation still owed when the
// offered entry expires is gone with it.
func TestOwedBoardLineExpiresWithItsOfferedEntry(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	bootThread(t, env)
	for _, id := range []string{"thread-owed", "thread-appended"} {
		record := threadRecord()
		record["board"] = map[string]any{"kind": "unblocked", "fiber": "a", "text": id}
		capture(t, env, ThreadPublication{ID: id, Record: record})
		f := resolved("host")
		f.ID = id
		route(t, env, f)
	}
	owed, err := OwedBoardLines(env)
	if err != nil || len(owed) != 2 {
		t.Fatal(owed, err)
	}
	settled := time.Now().Add(-mailboxRetention - time.Hour)
	for _, id := range []string{"thread-owed", "thread-appended"} {
		if err := os.Chtimes(filepath.Join(routingRoot(env), "offered", mailboxKey(id)+".json"), settled, settled); err != nil {
			t.Fatal(err)
		}
	}
	if err := BoardLineAppended(env, "thread-appended"); err != nil {
		t.Fatal(err)
	}
	owed, err = OwedBoardLines(env)
	if err != nil || len(owed) != 1 || owed[0].ID != "thread-owed" || owed[0].Board.(map[string]any)["text"] != "thread-owed" {
		t.Fatal(owed, err)
	}
	if err := pruneOffered(routingRoot(env), time.Now()); err != nil {
		t.Fatal(err)
	}
	if left, _ := os.ReadDir(filepath.Join(routingRoot(env), "offered")); len(left) != 0 {
		t.Fatal("recording the append restarted retention", left)
	}
	if owed, err = OwedBoardLines(env); err != nil || len(owed) != 0 {
		t.Fatal(owed, err)
	}
}
