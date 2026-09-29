package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
)

// ---- shared lifecycle test helpers -----------------------------------------

func newStore(t *testing.T) (string, *felt.Storage) {
	t.Helper()
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	return dir, storage
}

// seedFiber writes a fiber straight through storage, bypassing the cmd-layer
// validation — so a deliberately invalid block can be planted on disk.
func seedFiber(t *testing.T, storage *felt.Storage, id, uid, status string, block map[string]any, tempered *bool) {
	t.Helper()
	f := &felt.Felt{ID: id, UID: uid, Name: id, Status: status, CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}
	if block != nil {
		if err := f.SetExtraField("shuttle", block); err != nil {
			t.Fatalf("SetExtraField shuttle: %v", err)
		}
	}
	if tempered != nil {
		if err := f.SetExtraField("tempered", *tempered); err != nil {
			t.Fatalf("SetExtraField tempered: %v", err)
		}
	}
	if err := storage.Write(f); err != nil {
		t.Fatalf("Write %s: %v", id, err)
	}
}

// seedShuttleRole seeds a fiber carrying a shuttle: block plus the requested
// felt-native status and optional tempered verdict.
func seedShuttleRole(t *testing.T, storage *felt.Storage, id, status string, block map[string]any, tempered *bool) {
	t.Helper()
	seedFiber(t, storage, id, "", status, block, tempered)
}

func mustRead(t *testing.T, storage *felt.Storage, id string) *felt.Felt {
	t.Helper()
	f, err := storage.Read(id)
	if err != nil {
		t.Fatalf("Read %s: %v", id, err)
	}
	return f
}

// withStubbedTmux replaces the tmux func vars; returns a pointer to the slice of
// killed session names. `live` is the set of session names reported as existing.
func withStubbedTmux(t *testing.T, live map[string]bool) *[]string {
	t.Helper()
	prevExists, prevKill := tmuxSessionExists, killTmuxSession
	killed := &[]string{}
	tmuxSessionExists = func(name string) bool { return live[name] }
	killTmuxSession = func(name string) error { *killed = append(*killed, name); return nil }
	t.Cleanup(func() { tmuxSessionExists = prevExists; killTmuxSession = prevKill })
	return killed
}

func oneshot() map[string]any {
	return map[string]any{"kind": "oneshot", "agent": "claude-opus", "project_dir": "/srv/work"}
}

// ---- close -----------------------------------------------------------------

func TestShuttleClose_Tempered(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusActive, oneshot(), nil)

	if out, err := runCommand(t, dir, "shuttle", "close", "f", "--tempered=true"); err != nil {
		t.Fatalf("close: %v\n%s", err, out)
	}
	f := mustRead(t, storage, "f")
	if f.Status != felt.StatusClosed {
		t.Fatalf("status = %q, want closed", f.Status)
	}
	if tv := readTempered(f); tv == nil || !*tv {
		t.Fatalf("tempered should be true, got %v", tv)
	}
	if f.ClosedAt == nil {
		t.Fatal("closed-at should be stamped")
	}
}

func TestShuttleClose_AwaitingClearsTempered(t *testing.T) {
	dir, storage := newStore(t)
	yes := true
	seedShuttleRole(t, storage, "f", felt.StatusActive, oneshot(), &yes)

	if out, err := runCommand(t, dir, "shuttle", "close", "f"); err != nil {
		t.Fatalf("close: %v\n%s", err, out)
	}
	f := mustRead(t, storage, "f")
	if f.Status != felt.StatusClosed {
		t.Fatalf("status = %q, want closed", f.Status)
	}
	if tv := readTempered(f); tv != nil {
		t.Fatalf("tempered should be cleared (awaiting review), got %v", *tv)
	}
}

// ---- pause -----------------------------------------------------------------

func TestShuttlePause_KillsWorkerAndParks(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "proj/task", felt.StatusActive, oneshot(), nil)
	f0 := mustRead(t, storage, "proj/task")
	live := shuttleTmuxSessionName(f0.ID, f0.UID)
	killed := withStubbedTmux(t, map[string]bool{live: true})

	if out, err := runCommand(t, dir, "shuttle", "pause", "proj/task"); err != nil {
		t.Fatalf("pause: %v\n%s", err, out)
	}
	f := mustRead(t, storage, "proj/task")
	if f.Status != felt.StatusOpen {
		t.Fatalf("status = %q, want open", f.Status)
	}
	if len(*killed) != 1 || (*killed)[0] != live {
		t.Fatalf("expected to kill %q, killed %v", live, *killed)
	}
}

func TestShuttlePause_NoKillLeavesWorker(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "task", felt.StatusActive, oneshot(), nil)
	f := mustRead(t, storage, "task")
	killed := withStubbedTmux(t, map[string]bool{shuttleTmuxSessionName(f.ID, f.UID): true})

	if out, err := runCommand(t, dir, "shuttle", "pause", "task", "--no-kill"); err != nil {
		t.Fatalf("pause --no-kill: %v\n%s", err, out)
	}
	if len(*killed) != 0 {
		t.Fatalf("--no-kill must not kill, killed %v", *killed)
	}
	if mustRead(t, storage, "task").Status != felt.StatusOpen {
		t.Fatal("status should still be open")
	}
}

// ---- reopen ----------------------------------------------------------------

func TestShuttleReopen_ToActive(t *testing.T) {
	dir, storage := newStore(t)
	yes := true
	seedShuttleRole(t, storage, "f", felt.StatusClosed, oneshot(), &yes)

	if out, err := runCommand(t, dir, "shuttle", "reopen", "f"); err != nil {
		t.Fatalf("reopen: %v\n%s", err, out)
	}
	f := mustRead(t, storage, "f")
	if f.Status != felt.StatusActive {
		t.Fatalf("status = %q, want active", f.Status)
	}
	if readTempered(f) != nil || f.ClosedAt != nil {
		t.Fatal("reopen must clear tempered + closed-at")
	}
}

func TestShuttleReopen_AsDraft(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusClosed, oneshot(), nil)

	if out, err := runCommand(t, dir, "shuttle", "reopen", "f", "--as-draft"); err != nil {
		t.Fatalf("reopen --as-draft: %v\n%s", err, out)
	}
	if mustRead(t, storage, "f").Status != felt.StatusOpen {
		t.Fatal("--as-draft must reopen to status: open")
	}
}

// C1: `reopen --host <override>` is gone — post-S1, `resolveOwnHost` is pure
// local state (env var → host file → hostname; no daemon round-trip to guard
// against), so ambient resolution alone drives the ownership guard for
// reopen the same way it does for every other write verb. This regression
// test's whole premise (a --host override bypassing a MISMATCHED ambient
// identity) no longer applies; the alias-guard-fires-without-an-override
// half survives as `TestShuttleMarkRuntime_AliasGuardWithoutOverride`
// (cmd/shuttle_mark_runtime_test.go), which exercises the same guard on a
// different verb.

// ---- resume ----------------------------------------------------------------

func TestShuttleResume_DraftToActive(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusOpen, oneshot(), nil)

	if out, err := runCommand(t, dir, "shuttle", "resume", "f"); err != nil {
		t.Fatalf("resume: %v\n%s", err, out)
	}
	if mustRead(t, storage, "f").Status != felt.StatusActive {
		t.Fatal("resume should arm to active")
	}
}

func TestShuttleResume_RefusesClosed(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusClosed, oneshot(), nil)

	if _, err := runCommand(t, dir, "shuttle", "resume", "f"); err == nil {
		t.Fatal("resume on a closed oneshot must refuse (use reopen)")
	}
}

// TestShuttleResume_RequiresProjectDir: arming holds a draft to what an armed
// install requires. A draft installed --disabled without --project-dir is
// refused by resume (and by edit -s active) with the call that fixes it;
// resume --project-dir sets it and arms in one step.
func TestShuttleResume_RequiresProjectDir(t *testing.T) {
	dir, storage := newStore(t)
	if out, err := runCommand(t, dir, "add", "draft", "Draft"); err != nil {
		t.Fatalf("add: %v\n%s", err, out)
	}
	if out, err := runCommand(t, dir, "shuttle", "install", "draft", "--disabled"); err != nil {
		t.Fatalf("install --disabled: %v\n%s", err, out)
	}

	for _, args := range [][]string{
		{"shuttle", "resume", "draft"},
		{"edit", "draft", "-s", "active"},
	} {
		_, err := runCommand(t, dir, args...)
		if err == nil || !strings.Contains(err.Error(), "felt shuttle resume draft --project-dir") {
			t.Fatalf("%v on a draft with no project_dir: err=%v, want a refusal naming --project-dir", args, err)
		}
		if got := mustRead(t, storage, "draft").Status; got != felt.StatusOpen {
			t.Fatalf("%v armed the draft anyway: status=%q", args, got)
		}
	}

	work := t.TempDir()
	if out, err := runCommand(t, dir, "shuttle", "resume", "draft", "--project-dir", work); err != nil {
		t.Fatalf("resume --project-dir: %v\n%s", err, out)
	}
	f := mustRead(t, storage, "draft")
	b, _, err := f.ShuttleBlock()
	if err != nil || f.Status != felt.StatusActive || b.ProjectDir != work {
		t.Fatalf("after resume --project-dir: status=%q block=%#v err=%v", f.Status, b, err)
	}
}

// TestShuttleReopen_RequiresProjectDir: a closed fiber whose block has no
// project_dir is requeued by reopen, not resume, so the refusal — from reopen
// and from edit -s active alike — names reopen --project-dir, and that call
// arms it. (The daemon's force-dispatch shells reopen and relays this.)
func TestShuttleReopen_RequiresProjectDir(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "old", felt.StatusClosed, map[string]any{"kind": "oneshot", "agent": "claude-opus"}, nil)

	for _, args := range [][]string{
		{"shuttle", "reopen", "old"},
		{"edit", "old", "-s", "active"},
	} {
		_, err := runCommand(t, dir, args...)
		if err == nil || !strings.Contains(err.Error(), "felt shuttle reopen old --project-dir <dir>") {
			t.Fatalf("%v with no project_dir: err=%v, want a refusal naming reopen --project-dir", args, err)
		}
		if got := mustRead(t, storage, "old").Status; got != felt.StatusClosed {
			t.Fatalf("%v armed it anyway: status=%q", args, got)
		}
	}

	work := t.TempDir()
	if out, err := runCommand(t, dir, "shuttle", "reopen", "old", "--project-dir", work); err != nil {
		t.Fatalf("reopen --project-dir: %v\n%s", err, out)
	}
	f := mustRead(t, storage, "old")
	b, _, err := f.ShuttleBlock()
	if err != nil || f.Status != felt.StatusActive || b.ProjectDir != work {
		t.Fatalf("after reopen --project-dir: status=%q block=%#v err=%v", f.Status, b, err)
	}
}

// TestEditOfArmedFiberWithoutProjectDirIsNotArming: the gate is on the act
// of arming, not on an armed fiber. A standing role armed before project_dir
// was required still takes a tag or an outcome — from the board, or from the
// worker running it — and an edit that leaves it active arms nothing.
func TestEditOfArmedFiberWithoutProjectDirIsNotArming(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "role", felt.StatusActive, map[string]any{
		"kind": "standing", "agent": "claude-opus",
		"schedule": map[string]any{"expr": "0 13 * * *", "tz": "Europe/Paris"},
	}, nil)

	for _, args := range [][]string{
		{"edit", "role", "-t", "morning"},
		{"edit", "role", "-o", "digest sent"},
		{"edit", "role", "-s", "active"},
	} {
		if out, err := runCommand(t, dir, args...); err != nil {
			t.Fatalf("%v on an armed fiber: %v\n%s", args, err, out)
		}
	}
	if f := mustRead(t, storage, "role"); f.Outcome != "digest sent" || f.Status != felt.StatusActive {
		t.Fatalf("after edits: status=%q outcome=%q", f.Status, f.Outcome)
	}
}

// TestShuttleResume_StandingAwaitingRearmsAndConcludes: resume on a standing
// role awaiting review re-arms it and concludes the reviewed run in the same
// write — the handed_off_at stamp that keeps the poller from re-firing the
// occurrence that just ran.
func TestShuttleResume_StandingAwaitingRearmsAndConcludes(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusClosed, map[string]any{
		"kind": "standing", "agent": "claude-sonnet", "project_dir": "/srv/work",
		"schedule": map[string]any{"expr": "0 9 * * 1-5", "tz": "Europe/Paris"},
	}, nil)

	before := time.Now().UTC()
	if out, err := runCommand(t, dir, "shuttle", "resume", "f", "--local"); err != nil {
		t.Fatalf("resume --local: %v\n%s", err, out)
	}
	f := mustRead(t, storage, "f")
	if f.Status != felt.StatusActive || f.ClosedAt != nil {
		t.Fatalf("re-arm should set active + clear closed-at, got status=%q closedAt=%v", f.Status, f.ClosedAt)
	}
	raw, _ := shuttleRuntimeMap(t, f)["handed_off_at"].(string)
	handedOff, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil || handedOff.Before(before) {
		t.Fatalf("resume must stamp a fresh shuttle.runtime.handed_off_at, got %q (%v)", raw, err)
	}
}

func TestShuttleResume_OwnerRefusalDoesNotWriteLocally(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("the TCP owner check reads Linux /proc")
	}
	if os.Geteuid() == 0 {
		t.Skip("a root caller cannot distinguish a root listener from an unaccepted socket")
	}
	if !kernelShowsUnacceptedRowAsUIDZero(t) {
		t.Skip("this kernel stamps an unaccepted connection with our own uid, so a non-root test cannot stage a refused owner")
	}
	withOwnHost(t, "test-host")

	listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	settingsPath := filepath.Join(t.TempDir(), "host.json")
	setHostEnv(t, settingsPath, nil, nil)
	if err := os.WriteFile(settingsPath, []byte(fmt.Sprintf(`{"class":"shared-multi-user","listen":"tcp://%s"}`, listener.Addr())), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SHUTTLE_DAEMON_URL", "http://"+listener.Addr().String())

	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusClosed, map[string]any{
		"kind": "standing", "host": "test-host", "agent": "claude-sonnet",
		"project_dir": t.TempDir(),
		"schedule":    map[string]any{"expr": "0 9 * * 1-5", "tz": "Europe/Paris"},
	}, nil)

	out, err := runCommand(t, dir, "shuttle", "resume", "f")
	var ownerErr *daemonTCPOwnerCheckError
	if !errors.As(err, &ownerErr) {
		t.Fatalf("resume error = %v; want a TCP owner refusal\n%s", err, out)
	}
	if got := mustRead(t, storage, "f").Status; got != felt.StatusClosed {
		t.Fatalf("owner refusal wrote locally: status = %q, want %q", got, felt.StatusClosed)
	}
}

// ---- set-outcome -----------------------------------------------------------

func TestShuttleSetOutcome(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusActive, oneshot(), nil)

	if out, err := runCommand(t, dir, "shuttle", "set-outcome", "f", "--outcome", "Blocked: waiting on token"); err != nil {
		t.Fatalf("set-outcome: %v\n%s", err, out)
	}
	if got := mustRead(t, storage, "f").Outcome; got != "Blocked: waiting on token" {
		t.Fatalf("outcome = %q", got)
	}
}

// ---- accept ----------------------------------------------------------------

func TestShuttleAccept_RearmsAndKeepsOutcome(t *testing.T) {
	dir, storage := newStore(t)
	// Awaiting review: standing, closed, untempered, with a prior outcome.
	f := &felt.Felt{ID: "f", Name: "f", Status: felt.StatusClosed, Outcome: "prior digest", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}
	if err := f.SetExtraField("shuttle", map[string]any{
		"kind": "standing", "agent": "claude-sonnet", "project_dir": "/srv/work",
		"schedule": map[string]any{"expr": "0 9 * * 1-5", "tz": "Europe/Paris"},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := storage.Write(f); err != nil {
		t.Fatalf("write: %v", err)
	}

	if out, err := runCommand(t, dir, "shuttle", "accept", "f", "--local"); err != nil {
		t.Fatalf("accept --local: %v\n%s", err, out)
	}
	got := mustRead(t, storage, "f")
	if got.Status != felt.StatusActive {
		t.Fatalf("status = %q, want active", got.Status)
	}
	// The last run's digest stays the card's headline until the next run
	// writes its own.
	if got.Outcome != "prior digest" {
		t.Fatalf("accept must keep the outcome, got %q", got.Outcome)
	}
}

// TestShuttleAccept_StampsHandedOffAt: accept re-arms and prints a next
// occurrence, and must ALSO stamp shuttle.runtime.handed_off_at = now — the
// conclude-the-run signal. The poller's repeat-firing guard is
// `prev_due > last_serviced`, where last_serviced (standing_roles.ex
// last_serviced_at_ms) is the max of dispatched_at / handed_off_at /
// created_at. Without a fresh handed_off_at, last_serviced stays pinned at the
// prior dispatched_at, the guard is immediately satisfied, and the role fires
// on the very next poll — while this command just printed "next due: tomorrow
// morning" to the user.
func TestShuttleAccept_StampsHandedOffAt(t *testing.T) {
	dir, storage := newStore(t)

	// A prior dispatch from days ago is the run being accepted now. If accept
	// fails to advance last_serviced past this, the poller's
	// `prev_due > last_serviced` guard is satisfied on the very next tick.
	priorDispatch := "2026-07-20T09:00:00Z"
	f := &felt.Felt{ID: "f", Name: "f", Status: felt.StatusClosed, CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}
	if err := f.SetExtraField("shuttle", map[string]any{
		"kind": "standing", "agent": "claude-sonnet", "project_dir": "/srv/work",
		"schedule": map[string]any{"expr": "0 9 * * 1-5", "tz": "Europe/Paris"},
		"runtime":  map[string]any{"dispatched_at": priorDispatch},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := storage.Write(f); err != nil {
		t.Fatalf("write: %v", err)
	}

	before := time.Now().UTC()
	if out, err := runCommand(t, dir, "shuttle", "accept", "f", "--local"); err != nil {
		t.Fatalf("accept --local: %v\n%s", err, out)
	}
	after := time.Now().UTC()

	got := mustRead(t, storage, "f")
	rt := shuttleRuntimeMap(t, got)
	raw, ok := rt["handed_off_at"].(string)
	if !ok || raw == "" {
		t.Fatalf("shuttle.runtime.handed_off_at missing after accept: %#v", rt)
	}
	handedOff, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		t.Fatalf("handed_off_at %q not RFC3339: %v", raw, err)
	}
	if handedOff.Location() != time.UTC {
		// time.Parse with a "Z" offset yields UTC; guard against a future
		// regression that stamps local time instead.
		t.Fatalf("handed_off_at %q is not a UTC instant", raw)
	}
	if handedOff.Before(before) || handedOff.After(after) {
		t.Fatalf("handed_off_at %v is not within the accept call's window [%v, %v]", handedOff, before, after)
	}

	// The actual guard this closes: last_serviced (the max of dispatched_at /
	// handed_off_at / created_at) must now be the fresh stamp, not
	// the prior dispatch — so any prev_due at or before "now" does NOT satisfy
	// `prev_due > last_serviced` and the role stays quiet until its real next
	// occurrence.
	priorDispatchTime := mustParseTime(t, priorDispatch)
	if !handedOff.After(priorDispatchTime) {
		t.Fatalf("handed_off_at %v must be after the prior dispatched_at %v, or the poller's "+
			"prev_due > last_serviced guard is immediately satisfied and the role fires on the next poll",
			handedOff, priorDispatchTime)
	}
}

// TestShuttleAccept_RefusesDraftsAndVerdicts: accept resolves an untempered
// role only. A draft (status: open) and a closed role that already carries a
// verdict (tempered true or false) are refused and left as they were.
func TestShuttleAccept_RefusesDraftsAndVerdicts(t *testing.T) {
	standing := map[string]any{
		"kind": "standing", "agent": "claude-sonnet", "project_dir": "/srv/work",
		"schedule": map[string]any{"expr": "0 9 * * 1-5", "tz": "Europe/Paris"},
	}
	yes, no := true, false
	for _, tc := range []struct {
		name     string
		status   string
		tempered *bool
	}{
		{"draft", felt.StatusOpen, nil},
		{"tempered", felt.StatusClosed, &yes},
		{"composted", felt.StatusClosed, &no},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir, storage := newStore(t)
			seedShuttleRole(t, storage, "f", tc.status, standing, tc.tempered)
			if _, err := runCommand(t, dir, "shuttle", "accept", "f", "--local"); err == nil {
				t.Fatal("accept must refuse")
			}
			if got := mustRead(t, storage, "f").Status; got != tc.status {
				t.Fatalf("refused accept wrote status %q", got)
			}
		})
	}
}

// TestShuttleAccept_ActiveStandingRoleConcludesRun: the board's Temper gesture
// can land while a standing run is still in flight (status: active, the exit
// writer not yet run). Accept keeps the role armed and concludes the run, so
// the schedule's next tick is the next dispatch; an already-armed role is not
// re-held to the arming gate.
func TestShuttleAccept_ActiveStandingRoleConcludesRun(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusActive, map[string]any{
		"kind": "standing", "agent": "claude-sonnet",
		"schedule": map[string]any{"expr": "0 9 * * 1-5", "tz": "Europe/Paris"},
	}, nil)

	if out, err := runCommand(t, dir, "shuttle", "accept", "f", "--local"); err != nil {
		t.Fatalf("accept on an active standing role: %v\n%s", err, out)
	}
	got := mustRead(t, storage, "f")
	if got.Status != felt.StatusActive {
		t.Fatalf("status = %q, want active", got.Status)
	}
	if raw, _ := shuttleRuntimeMap(t, got)["handed_off_at"].(string); raw == "" {
		t.Fatal("accept must conclude the in-flight run (shuttle.runtime.handed_off_at)")
	}
}

// TestShuttleAccept_RoutesThroughDaemonWithoutHoldingTheLock: with a daemon
// reachable, accept hands the fiber to it — {"action":"accept","fiber":<id>},
// nothing else — and relays its answer. The daemon's writer is this same verb
// run with --local, which takes the fiber lock, so the CLI must not hold that
// lock while it waits: the stand-in daemon takes it inside the request.
func TestShuttleAccept_RoutesThroughDaemonWithoutHoldingTheLock(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusClosed, map[string]any{
		"kind": "standing", "agent": "claude-sonnet", "project_dir": "/srv/work",
		"schedule": map[string]any{"expr": "0 9 * * 1-5", "tz": "Europe/Paris"},
	}, nil)

	var got map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/lifecycle" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		unlock, err := storage.LockFiber("f")
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		_ = unlock()
		fmt.Fprint(w, "accepted by the daemon\n")
	}))
	defer server.Close()
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)

	out, err := runCommand(t, dir, "shuttle", "accept", "f")
	if err != nil {
		t.Fatalf("routed accept: %v\n%s", err, out)
	}
	if !strings.Contains(out, "accepted by the daemon") {
		t.Fatalf("daemon answer not relayed: %q", out)
	}
	if want := map[string]any{"action": "accept", "fiber": "f"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("lifecycle request = %v, want %v", got, want)
	}
	if status := mustRead(t, storage, "f").Status; status != felt.StatusClosed {
		t.Fatalf("a routed accept also wrote locally: status = %q", status)
	}
}

// TestShuttleAccept_UnreachableDaemonWritesLocally: a daemon that cannot be
// reached leaves the write to this process.
func TestShuttleAccept_UnreachableDaemonWritesLocally(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusClosed, map[string]any{
		"kind": "standing", "agent": "claude-sonnet", "project_dir": "/srv/work",
		"schedule": map[string]any{"expr": "0 9 * * 1-5", "tz": "Europe/Paris"},
	}, nil)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := listener.Addr().String()
	listener.Close()
	t.Setenv("SHUTTLE_DAEMON_URL", "http://"+addr)

	if out, err := runCommand(t, dir, "shuttle", "accept", "f"); err != nil {
		t.Fatalf("accept with the daemon down: %v\n%s", err, out)
	}
	if status := mustRead(t, storage, "f").Status; status != felt.StatusActive {
		t.Fatalf("status = %q, want active", status)
	}
}

// TestShuttleAccept_DaemonThatDoesNotAnswerInTimeIsNotUnreachable: a daemon
// that took the connection but answers after the client gives up may still
// apply the accept, so the CLI neither writes locally (which would refuse once
// the daemon's accept lands) nor claims a refusal: it says the transition may
// still apply.
func TestShuttleAccept_DaemonThatDoesNotAnswerInTimeIsNotUnreachable(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusClosed, map[string]any{
		"kind": "standing", "agent": "claude-sonnet", "project_dir": "/srv/work",
		"schedule": map[string]any{"expr": "0 9 * * 1-5", "tz": "Europe/Paris"},
	}, nil)

	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
		fmt.Fprint(w, "accepted by the daemon\n")
	}))
	defer server.Close()
	defer close(release)
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)

	prev := daemonLifecycleTimeout
	daemonLifecycleTimeout = 200 * time.Millisecond
	t.Cleanup(func() { daemonLifecycleTimeout = prev })

	out, err := runCommand(t, dir, "shuttle", "accept", "f")
	if err == nil {
		t.Fatalf("an unanswered accept reported success:\n%s", out)
	}
	for _, want := range []string{"did not answer in time", "may still apply", "felt show f"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not say %q", err, want)
		}
	}
	if status := mustRead(t, storage, "f").Status; status != felt.StatusClosed {
		t.Fatalf("an unanswered accept fell back to a local write: status = %q", status)
	}
}

func TestShuttleAccept_RejectsOneshot(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusClosed, oneshot(), nil)

	if _, err := runCommand(t, dir, "shuttle", "accept", "f", "--local"); err == nil {
		t.Fatal("accept on a oneshot must refuse (standing/pinned only)")
	}
}

func TestShuttleAccept_PinnedReParks(t *testing.T) {
	dir, storage := newStore(t)
	// Awaiting review: pinned, closed, untempered — the arc finished and is
	// pending the human verdict. Accept RE-PARKS it to the strip (status: open),
	// the kind-aware other half of accept (standing re-arms active).
	closedAt := mustParseTime(t, "2026-07-10T09:00:00Z")
	f := &felt.Felt{ID: "f", Name: "f", Status: felt.StatusClosed, ClosedAt: &closedAt}
	if err := f.SetExtraField("shuttle", map[string]any{
		"kind": "pinned", "agent": "claude-opus",
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := storage.Write(f); err != nil {
		t.Fatalf("write: %v", err)
	}

	if out, err := runCommand(t, dir, "shuttle", "accept", "f", "--local"); err != nil {
		t.Fatalf("accept pinned --local: %v\n%s", err, out)
	}
	got := mustRead(t, storage, "f")
	if got.Status != felt.StatusOpen {
		t.Fatalf("status = %q, want open (re-parked to the strip)", got.Status)
	}
	if readTempered(got) != nil {
		t.Fatalf("accept should clear tempered, got %v", readTempered(got))
	}
	if got.ClosedAt != nil {
		t.Fatalf("accept should clear closed-at, got %v", got.ClosedAt)
	}
}

// ---- set-model / set-agent -------------------------------------------------

func TestShuttleSetModel_PreservesRuntimeKeys(t *testing.T) {
	withOwnHost(t, "h") // block is host-pinned; own-host must match for the guard to pass
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusActive, map[string]any{
		"kind": "oneshot", "agent": "claude-opus", "host": "h",
		"session_uuid": "abc-123", "dispatched_at": "2026-06-21T00:00:00Z",
	}, nil)

	if out, err := runCommand(t, dir, "shuttle", "set-model", "f", "claude-sonnet"); err != nil {
		t.Fatalf("set-model: %v\n%s", err, out)
	}
	f := mustRead(t, storage, "f")
	b, _, err := f.ShuttleBlock()
	if err != nil {
		t.Fatalf("ShuttleBlock: %v", err)
	}
	if b.Agent != "claude-sonnet" {
		t.Fatalf("agent = %q, want claude-sonnet", b.Agent)
	}
	// Runtime siblings must survive the surgical write (the timestamp round-trips
	// quoted, so match key + value separately).
	raw, _ := os.ReadFile(storage.Path(f.ID))
	for _, want := range []string{"session_uuid: abc-123", "dispatched_at:", "2026-06-21T00:00:00Z"} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("runtime key clobbered: missing %q in\n%s", want, raw)
		}
	}
}

func TestShuttleSettingsPreserveLifecycle(t *testing.T) {
	for _, status := range []string{felt.StatusOpen, felt.StatusActive, felt.StatusClosed} {
		for _, verb := range []string{"set-agent", "set-model"} {
			t.Run(status+"/"+verb, func(t *testing.T) {
				dir, storage := newStore(t)
				seedShuttleRole(t, storage, "f", status, map[string]any{
					"kind": "oneshot", "agent": "claude-opus",
					"runtime": map[string]any{"session_uuid": "keep-conversation", "dispatched_at": "2026-06-21T00:00:00Z", "handed_off_at": "2026-06-21T01:00:00Z"},
				}, nil)
				before := mustRead(t, storage, "f")
				args := []string{"shuttle", verb, "f", "claude-sonnet"}
				if verb == "set-agent" {
					args = append(args, "--effort", "high", "--chrome", "--surface", "cli")
				}
				if out, err := runCommand(t, dir, args...); err != nil {
					t.Fatalf("settings: %v\n%s", err, out)
				}
				after := mustRead(t, storage, "f")
				if after.Status != before.Status || after.Outcome != before.Outcome {
					t.Fatalf("settings changed lifecycle: before=%+v after=%+v", before, after)
				}
				raw, _ := os.ReadFile(storage.Path(after.ID))
				for _, marker := range []string{"keep-conversation", "2026-06-21T00:00:00Z", "2026-06-21T01:00:00Z"} {
					if !strings.Contains(string(raw), marker) {
						t.Fatalf("settings erased runtime marker %s", marker)
					}
				}
			})
		}
	}
}

func TestShuttleSetModel_RejectsUnknownAgent(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusActive, oneshot(), nil)

	if _, err := runCommand(t, dir, "shuttle", "set-model", "f", "no-such-agent"); err == nil {
		t.Fatal("set-model with an unknown agent must fail validation")
	}
}

func TestShuttleSetAgent_AxesSurgical(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusActive, map[string]any{
		"kind": "oneshot", "agent": "claude-opus",
		"session_uuid": "keep-me",
	}, nil)

	if out, err := runCommand(t, dir, "shuttle", "set-agent", "f", "claude-sonnet", "--effort", "high"); err != nil {
		t.Fatalf("set-agent: %v\n%s", err, out)
	}
	f := mustRead(t, storage, "f")
	b, _, err := f.ShuttleBlock()
	if err != nil {
		t.Fatalf("ShuttleBlock: %v", err)
	}
	if b.Agent != "claude-sonnet" || b.Effort != "high" {
		t.Fatalf("axes not set: %+v", b)
	}
	raw, _ := os.ReadFile(storage.Path(f.ID))
	if !strings.Contains(string(raw), "session_uuid: keep-me") {
		t.Fatalf("runtime key clobbered:\n%s", raw)
	}
}

func TestShuttleSetAgent_PreservesAndEditsSurface(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusActive, map[string]any{
		"kind": "oneshot", "agent": "codex-sol", "surface": "cli",
		"session_uuid": "keep-me",
	}, nil)

	// An agent switch within Codex leaves an explicit CLI selection intact.
	if out, err := runCommand(t, dir, "shuttle", "set-agent", "f", "codex-luna"); err != nil {
		t.Fatalf("set-agent preserving surface: %v\n%s", err, out)
	}
	f := mustRead(t, storage, "f")
	b, _, err := f.ShuttleBlock()
	if err != nil || b.Surface != "cli" {
		t.Fatalf("surface after Codex switch = %#v, %v; want cli", b, err)
	}

	if out, err := runCommand(t, dir, "shuttle", "set-agent", "f", "codex-luna", "--surface", "app"); err != nil {
		t.Fatalf("set-agent app: %v\n%s", err, out)
	}
	f = mustRead(t, storage, "f")
	b, _, err = f.ShuttleBlock()
	if err != nil || b.Surface != "app" {
		t.Fatalf("surface after explicit edit = %#v, %v; want app", b, err)
	}
	if _, err := runCommand(t, dir, "shuttle", "set-agent", "f", "claude-opus"); err == nil {
		t.Fatal("switching an app block away from Codex without choosing cli must fail")
	}
}

// TestShuttleSetModel_KeepsSurfaceConsistentWithAgent: set-model and set-agent
// share one composition rule, so set-model cannot move a surface: app block to
// a non-Codex agent either — which used to leave a block set-agent then
// refused. The refusal names the call that does move it.
func TestShuttleSetModel_KeepsSurfaceConsistentWithAgent(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusActive, map[string]any{
		"kind": "oneshot", "agent": "codex-sol", "surface": "app",
	}, nil)

	_, err := runCommand(t, dir, "shuttle", "set-model", "f", "claude-opus")
	if err == nil || !strings.Contains(err.Error(), "--surface cli") {
		t.Fatalf("set-model to Claude on an app block: err=%v, want a refusal naming --surface cli", err)
	}
	b, _, err := mustRead(t, storage, "f").ShuttleBlock()
	if err != nil || b.Agent != "codex-sol" || b.Surface != "app" {
		t.Fatalf("refused set-model still wrote: %#v, %v", b, err)
	}

	// Within Codex, set-model keeps the surface.
	if out, err := runCommand(t, dir, "shuttle", "set-model", "f", "codex-luna"); err != nil {
		t.Fatalf("set-model within Codex: %v\n%s", err, out)
	}
	if b, _, err := mustRead(t, storage, "f").ShuttleBlock(); err != nil || b.Agent != "codex-luna" || b.Surface != "app" {
		t.Fatalf("after set-model codex-luna: %#v, %v", b, err)
	}

	// The named repair works, and leaves a block set-agent accepts.
	if out, err := runCommand(t, dir, "shuttle", "set-agent", "f", "claude-opus", "--surface", "cli"); err != nil {
		t.Fatalf("set-agent --surface cli: %v\n%s", err, out)
	}
	if out, err := runCommand(t, dir, "shuttle", "set-agent", "f", "--effort", "high"); err != nil {
		t.Fatalf("set-agent after the move: %v\n%s", err, out)
	}
}

// ---- uninstall -------------------------------------------------------------

func TestShuttleUninstall_RemovesBlock(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusActive, oneshot(), nil)

	if out, err := runCommand(t, dir, "shuttle", "uninstall", "f"); err != nil {
		t.Fatalf("uninstall: %v\n%s", err, out)
	}
	if mustRead(t, storage, "f").HasShuttleFacet() {
		t.Fatal("uninstall must remove the shuttle: block")
	}
	// Idempotent: a second uninstall is a no-op (nothing to do), not an error.
	if out, err := runCommand(t, dir, "shuttle", "uninstall", "f"); err != nil {
		t.Fatalf("second uninstall should be a no-op: %v\n%s", err, out)
	}
}

// ---- ownership guard -------------------------------------------------------

func TestShuttleOwnershipGuard_RefusesRemoteOwned(t *testing.T) {
	withOwnHost(t, "macbook")
	writeRemotes(t, `{"version":1,"remotes":[]}`)
	t.Setenv("SHUTTLE_DAEMON_URL", "http://127.0.0.1:1")
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "remote", felt.StatusActive, map[string]any{
		"kind": "oneshot", "agent": "claude-opus", "host": "cineca",
	}, nil)
	before, _ := os.ReadFile(storage.Path("remote"))

	_, err := runCommand(t, dir, "shuttle", "close", "remote", "--tempered=true")
	if err == nil {
		t.Fatal("close on a cineca-owned fiber from macbook must be refused")
	}
	if !strings.Contains(err.Error(), "not an enabled remote") || !strings.Contains(err.Error(), "felt shuttle close remote") {
		t.Fatalf("expected an actionable routing refusal, got %T: %v", err, err)
	}
	after, _ := os.ReadFile(storage.Path("remote"))
	if string(before) != string(after) {
		t.Fatalf("refused write must leave the mirror byte-identical")
	}
}

func TestShuttleOwnershipGuard_WritesOwnedHere(t *testing.T) {
	withOwnHost(t, "cineca")
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "owned", felt.StatusActive, map[string]any{
		"kind": "oneshot", "agent": "claude-opus", "host": "cineca",
	}, nil)

	if out, err := runCommand(t, dir, "shuttle", "close", "owned", "--tempered=true"); err != nil {
		t.Fatalf("close on a fiber owned here must succeed: %v\n%s", err, out)
	}
	if tv := readTempered(mustRead(t, storage, "owned")); tv == nil || !*tv {
		t.Fatal("owned close should write tempered: true")
	}
}

// ---- retired agents --------------------------------------------------------

// A closed constitution that still names a retired agent id is history, not a
// dispatch: content edits go through; arming verbs refuse until the agent is
// changed to a current one.
func TestShuttleRetiredAgent_EditPassesResumeRefuses(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusOpen, map[string]any{"kind": "oneshot", "agent": "retired-agent", "project_dir": "/srv/work"}, nil)

	if out, err := runCommand(t, dir, "edit", "f", "-o", "still editable"); err != nil {
		t.Fatalf("edit with a retired agent must succeed: %v\n%s", err, out)
	}
	if got := mustRead(t, storage, "f").Outcome; got != "still editable" {
		t.Fatalf("outcome not written, got %q", got)
	}

	if out, err := runCommand(t, dir, "shuttle", "resume", "f"); err == nil {
		t.Fatalf("resume must refuse a retired agent\n%s", out)
	} else if !strings.Contains(err.Error()+out, "retired-agent") {
		t.Fatalf("refusal should name the agent, got: %v\n%s", err, out)
	}
	if mustRead(t, storage, "f").Status != felt.StatusOpen {
		t.Fatal("refused resume must not arm the fiber")
	}

	if out, err := runCommand(t, dir, "shuttle", "reopen", "f"); err == nil {
		t.Fatalf("reopen must refuse a retired agent\n%s", out)
	}
	if out, err := runCommand(t, dir, "shuttle", "reopen", "--as-draft", "f"); err != nil {
		t.Fatalf("reopen --as-draft arms nothing and must pass: %v\n%s", err, out)
	}
}

// TestShuttleRetiredAgent_EditStatusActiveRefuses covers the second arming
// gate the reviewer flagged: `edit --status active` on a fiber carrying a
// shuttle: block must resolve the agent, same as resume/reopen. A plain
// content edit (no status flip, or a flip to a non-arming status) must still
// pass untouched.
func TestShuttleRetiredAgent_EditStatusActiveRefuses(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusOpen, map[string]any{"kind": "oneshot", "agent": "retired-agent", "project_dir": "/srv/work"}, nil)

	if out, err := runCommand(t, dir, "edit", "f", "-s", "active"); err == nil {
		t.Fatalf("edit -s active with a retired agent must refuse\n%s", out)
	} else if !strings.Contains(err.Error()+out, "retired-agent") {
		t.Fatalf("refusal should name the agent, got: %v\n%s", err, out)
	}
	if mustRead(t, storage, "f").Status != felt.StatusOpen {
		t.Fatal("refused edit -s active must not arm the fiber")
	}

	if out, err := runCommand(t, dir, "edit", "f", "-s", "closed"); err != nil {
		t.Fatalf("edit -s closed (non-arming) must pass even with a retired agent: %v\n%s", err, out)
	}
	if got := mustRead(t, storage, "f").Status; got != felt.StatusClosed {
		t.Fatalf("status = %q, want closed", got)
	}
}

// TestShuttleRetiredAgent_AcceptRefuses covers accept's arming gate: a
// standing role awaiting review with a retired agent must refuse rather than
// silently re-arm.
func TestShuttleRetiredAgent_AcceptRefuses(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusClosed, map[string]any{
		"kind": "standing", "agent": "retired-agent", "project_dir": "/srv/work",
		"schedule": map[string]any{"expr": "0 9 * * 1-5", "tz": "Europe/Paris"},
	}, nil)

	if out, err := runCommand(t, dir, "shuttle", "accept", "f", "--local"); err == nil {
		t.Fatalf("accept must refuse a retired agent\n%s", out)
	} else if !strings.Contains(err.Error()+out, "retired-agent") {
		t.Fatalf("refusal should name the agent, got: %v\n%s", err, out)
	}
	if mustRead(t, storage, "f").Status != felt.StatusClosed {
		t.Fatal("refused accept must not arm the fiber")
	}
}
