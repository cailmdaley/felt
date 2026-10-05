package shuttlecli

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/cailmdaley/felt/internal/sysenv"
)

// ---- shared lifecycle test helpers -----------------------------------------

// withStubbedTmux is an app whose tmux probes answer from live (the set of
// session names reported as existing) and record each kill in the returned
// slice instead of reaching a tmux server.
func withStubbedTmux(t *testing.T, env *sysenv.Env, live map[string]bool) (*app, *[]string) {
	t.Helper()
	a := newApp(env)
	killed := &[]string{}
	a.tmuxSessionExists = func(name string) bool { return live[name] }
	a.killTmuxSession = func(name string) error { *killed = append(*killed, name); return nil }
	return a, killed
}

// runIn runs one shuttle invocation in env with dir as the -C default and
// returns its stdout.
func runIn(t *testing.T, env *sysenv.Env, dir string, args ...string) (string, error) {
	t.Helper()
	stdout, _, err := executeIn(t, env, dir, args...)
	return stdout, err
}

// ---- close -----------------------------------------------------------------

func TestShuttleClose_Tempered(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusActive, oneshot(), nil)

	if out, err := runIn(t, env, dir, "close", "f", "--tempered=true"); err != nil {
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
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	yes := true
	seedShuttleRole(t, storage, "f", felt.StatusActive, oneshot(), &yes)

	if out, err := runIn(t, env, dir, "close", "f"); err != nil {
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
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "proj/task", felt.StatusActive, oneshot(), nil)
	f0 := mustRead(t, storage, "proj/task")
	live := shuttleTmuxSessionName(f0.ID, f0.UID)
	a, killed := withStubbedTmux(t, env, map[string]bool{live: true})

	if out, _, err := executeApp(t, a, dir, "pause", "proj/task"); err != nil {
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
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "task", felt.StatusActive, oneshot(), nil)
	f := mustRead(t, storage, "task")
	a, killed := withStubbedTmux(t, env, map[string]bool{shuttleTmuxSessionName(f.ID, f.UID): true})

	if out, _, err := executeApp(t, a, dir, "pause", "task", "--no-kill"); err != nil {
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
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	yes := true
	seedShuttleRole(t, storage, "f", felt.StatusClosed, oneshot(), &yes)

	if out, err := runIn(t, env, dir, "reopen", "f"); err != nil {
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
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusClosed, oneshot(), nil)

	if out, err := runIn(t, env, dir, "reopen", "f", "--as-draft"); err != nil {
		t.Fatalf("reopen --as-draft: %v\n%s", err, out)
	}
	if mustRead(t, storage, "f").Status != felt.StatusOpen {
		t.Fatal("--as-draft must reopen to status: open")
	}
}

// ---- resume ----------------------------------------------------------------

func TestShuttleResume_DraftToActive(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusOpen, oneshot(), nil)

	if out, err := runIn(t, env, dir, "resume", "f"); err != nil {
		t.Fatalf("resume: %v\n%s", err, out)
	}
	if mustRead(t, storage, "f").Status != felt.StatusActive {
		t.Fatal("resume should arm to active")
	}
}

func TestShuttleResume_RefusesClosed(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusClosed, oneshot(), nil)

	if _, err := runIn(t, env, dir, "resume", "f"); err == nil {
		t.Fatal("resume on a closed oneshot must refuse (use reopen)")
	}
}

// TestShuttleResume_RequiresProjectDir checks that resuming a draft requires
// the worker directory and that resume --project-dir sets it while arming.
func TestShuttleResume_RequiresProjectDir(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	if err := storage.Write(&felt.Felt{ID: "draft", Name: "Draft"}); err != nil {
		t.Fatalf("write draft: %v", err)
	}
	if out, err := runIn(t, env, dir, "install", "draft", "--disabled"); err != nil {
		t.Fatalf("install --disabled: %v\n%s", err, out)
	}

	_, err := runIn(t, env, dir, "resume", "draft")
	if err == nil || !strings.Contains(err.Error(), "shuttle resume draft --project-dir") {
		t.Fatalf("resume without project_dir: err=%v, want a refusal naming --project-dir", err)
	}
	if got := mustRead(t, storage, "draft").Status; got != felt.StatusOpen {
		t.Fatalf("refused resume changed status to %q", got)
	}

	work := t.TempDir()
	if out, err := runIn(t, env, dir, "resume", "draft", "--project-dir", work); err != nil {
		t.Fatalf("resume --project-dir: %v\n%s", err, out)
	}
	f := mustRead(t, storage, "draft")
	b, _, err := shuttle.BlockOf(f)
	if err != nil || f.Status != felt.StatusActive || b.ProjectDir != work {
		t.Fatalf("after resume --project-dir: status=%q block=%#v err=%v", f.Status, b, err)
	}
}

// TestShuttleReopen_RequiresProjectDir checks that reopen requires a worker
// directory when it makes a closed fiber dispatchable.
func TestShuttleReopen_RequiresProjectDir(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "old", felt.StatusClosed, map[string]any{"kind": "oneshot", "agent": "claude-opus"}, nil)

	_, err := runIn(t, env, dir, "reopen", "old")
	if err == nil || !strings.Contains(err.Error(), "shuttle reopen old --project-dir <dir>") {
		t.Fatalf("reopen without project_dir: err=%v, want a refusal naming --project-dir", err)
	}
	if got := mustRead(t, storage, "old").Status; got != felt.StatusClosed {
		t.Fatalf("refused reopen changed status to %q", got)
	}

	work := t.TempDir()
	if out, err := runIn(t, env, dir, "reopen", "old", "--project-dir", work); err != nil {
		t.Fatalf("reopen --project-dir: %v\n%s", err, out)
	}
	f := mustRead(t, storage, "old")
	b, _, err := shuttle.BlockOf(f)
	if err != nil || f.Status != felt.StatusActive || b.ProjectDir != work {
		t.Fatalf("after reopen --project-dir: status=%q block=%#v err=%v", f.Status, b, err)
	}
}

// TestShuttleReopen_StandingWithDirectoryLeavesItsRunOpen: reopening a closed
// standing role with --project-dir sets the directory and arms the role in one
// write, and leaves shuttle.runtime alone — the reopened role re-fires the
// occurrence it stood on.
func TestShuttleReopen_StandingWithDirectoryLeavesItsRunOpen(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	tempered := false
	seedShuttleRole(t, storage, "f", felt.StatusClosed, map[string]any{
		"kind": "standing", "agent": "claude-sonnet",
		"schedule": map[string]any{"expr": "0 9 * * 1-5", "tz": "Europe/Paris"},
	}, &tempered)
	work := t.TempDir()

	if out, err := runIn(t, env, dir, "reopen", "f", "--project-dir", work, "--local"); err != nil {
		t.Fatalf("reopen --project-dir --local: %v\n%s", err, out)
	}
	f := mustRead(t, storage, "f")
	b, _, err := shuttle.BlockOf(f)
	if err != nil || f.Status != felt.StatusActive || f.ClosedAt != nil || b.ProjectDir != work {
		t.Fatalf("after reopen: status=%q closedAt=%v block=%#v err=%v", f.Status, f.ClosedAt, b, err)
	}
	var block map[string]any
	if err := f.ExtraFields["shuttle"].Decode(&block); err != nil {
		t.Fatalf("decoding shuttle: block: %v", err)
	}
	if rt, ok := block["runtime"].(map[string]any); ok && rt["handed_off_at"] != nil {
		t.Fatalf("reopen must not conclude a standing role's run, got handed_off_at=%v", rt["handed_off_at"])
	}
}

// TestShuttleReopen_ConcludeRunStampsAStandingRole: the daemon's forced start
// reopens with --conclude-run, which arms the role, saves the directory and
// stamps handed_off_at in one write.
func TestShuttleReopen_ConcludeRunStampsAStandingRole(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	tempered := false
	seedShuttleRole(t, storage, "f", felt.StatusClosed, map[string]any{
		"kind": "standing", "agent": "claude-sonnet",
		"schedule": map[string]any{"expr": "0 9 * * 1-5", "tz": "Europe/Paris"},
	}, &tempered)
	work := t.TempDir()

	before := time.Now().UTC()
	if out, err := runIn(t, env, dir, "reopen", "f", "--project-dir", work, "--conclude-run", "--local"); err != nil {
		t.Fatalf("reopen --conclude-run: %v\n%s", err, out)
	}
	f := mustRead(t, storage, "f")
	b, _, err := shuttle.BlockOf(f)
	if err != nil || f.Status != felt.StatusActive || b.ProjectDir != work {
		t.Fatalf("after reopen: status=%q block=%#v err=%v", f.Status, b, err)
	}
	raw, _ := shuttleRuntimeMap(t, f)["handed_off_at"].(string)
	handedOff, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil || handedOff.Before(before) {
		t.Fatalf("--conclude-run must stamp handed_off_at, got %q (%v)", raw, err)
	}
}

// TestShuttleResolveDir_MatchesWhatReopenSaves: resolve-dir and
// reopen --project-dir expand the same raw input to the same path, even when
// a variable's value itself holds a "$".
func TestShuttleResolveDir_MatchesWhatReopenSaves(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "old", felt.StatusClosed, map[string]any{
		"kind": "oneshot", "agent": "claude-sonnet",
	}, nil)
	literal := filepath.Join(t.TempDir(), "checkout$SUFFIX")
	if err := os.MkdirAll(literal, 0o755); err != nil {
		t.Fatal(err)
	}
	env.Set("SUFFIX", "other")
	env.Set("SHUTTLE_ROOT", literal)

	out, err := runIn(t, env, dir, "resolve-dir", "$SHUTTLE_ROOT")
	if err != nil || strings.TrimSpace(out) != literal {
		t.Fatalf("resolve-dir: out=%q err=%v, want %q", out, err, literal)
	}
	if out, err := runIn(t, env, dir, "reopen", "old", "--project-dir", "$SHUTTLE_ROOT", "--local"); err != nil {
		t.Fatalf("reopen --project-dir: %v\n%s", err, out)
	}
	b, _, err := shuttle.BlockOf(mustRead(t, storage, "old"))
	if err != nil || b.ProjectDir != literal {
		t.Fatalf("reopen saved %q (err %v), resolve-dir said %q", b.ProjectDir, err, literal)
	}
}

// TestShuttleResolveDir expands like --project-dir and writes nothing.
func TestShuttleResolveDir(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, _ := newStore(t)
	work := t.TempDir()
	env.Set("SHUTTLE_RESOLVE_TEST", work)
	out, err := runIn(t, env, dir, "resolve-dir", "$SHUTTLE_RESOLVE_TEST")
	if err != nil || strings.TrimSpace(out) != work {
		t.Fatalf("resolve-dir: out=%q err=%v, want %q", out, err, work)
	}
	if _, err := runIn(t, env, dir, "resolve-dir", work+"/missing"); err == nil {
		t.Fatal("resolve-dir must refuse a path that is not a directory")
	}
}

// TestShuttleResume_StandingAwaitingRearmsAndConcludes: resume on a standing
// role awaiting review re-arms it and concludes the reviewed run in the same
// write — the handed_off_at stamp that keeps the poller from re-firing the
// occurrence that just ran.
func TestShuttleResume_StandingAwaitingRearmsAndConcludes(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusClosed, map[string]any{
		"kind": "standing", "agent": "claude-sonnet", "project_dir": "/srv/work",
		"schedule": map[string]any{"expr": "0 9 * * 1-5", "tz": "Europe/Paris"},
	}, nil)

	before := time.Now().UTC()
	if out, err := runIn(t, env, dir, "resume", "f", "--local"); err != nil {
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
	t.Parallel()
	env := testEnv(t)
	if runtime.GOOS != "linux" {
		t.Skip("the TCP owner check reads Linux /proc")
	}
	if os.Geteuid() == 0 {
		t.Skip("a root caller cannot distinguish a root listener from an unaccepted socket")
	}
	if !kernelShowsUnacceptedRowAsUIDZero(t) {
		t.Skip("this kernel stamps an unaccepted connection with our own uid, so a non-root test cannot stage a refused owner")
	}
	ownHost(t, env, "test-host")

	listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	settingsPath := filepath.Join(t.TempDir(), "host.json")
	setHostEnvIn(t, env, settingsPath, nil, nil)
	if err := os.WriteFile(settingsPath, []byte(fmt.Sprintf(`{"class":"shared-multi-user","listen":"tcp://%s"}`, listener.Addr())), 0o600); err != nil {
		t.Fatal(err)
	}
	env.Set("SHUTTLE_DAEMON_URL", "http://"+listener.Addr().String())

	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusClosed, map[string]any{
		"kind": "standing", "host": "test-host", "agent": "claude-sonnet",
		"project_dir": t.TempDir(),
		"schedule":    map[string]any{"expr": "0 9 * * 1-5", "tz": "Europe/Paris"},
	}, nil)

	out, err := runIn(t, env, dir, "resume", "f")
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
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusActive, oneshot(), nil)

	if out, err := runIn(t, env, dir, "set-outcome", "f", "--outcome", "Blocked: waiting on token"); err != nil {
		t.Fatalf("set-outcome: %v\n%s", err, out)
	}
	if got := mustRead(t, storage, "f").Outcome; got != "Blocked: waiting on token" {
		t.Fatalf("outcome = %q", got)
	}
}

// ---- accept ----------------------------------------------------------------

func TestShuttleAccept_RearmsAndKeepsOutcome(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
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

	if out, err := runIn(t, env, dir, "accept", "f", "--local"); err != nil {
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
	t.Parallel()
	env := testEnv(t)
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
	if out, err := runIn(t, env, dir, "accept", "f", "--local"); err != nil {
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
	t.Parallel()
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
			t.Parallel()
			env := testEnv(t)
			dir, storage := newStore(t)
			seedShuttleRole(t, storage, "f", tc.status, standing, tc.tempered)
			if _, err := runIn(t, env, dir, "accept", "f", "--local"); err == nil {
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
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusActive, map[string]any{
		"kind": "standing", "agent": "claude-sonnet",
		"schedule": map[string]any{"expr": "0 9 * * 1-5", "tz": "Europe/Paris"},
	}, nil)

	if out, err := runIn(t, env, dir, "accept", "f", "--local"); err != nil {
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
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusClosed, map[string]any{
		"kind": "standing", "agent": "claude-sonnet", "project_dir": "/srv/work",
		"schedule": map[string]any{"expr": "0 9 * * 1-5", "tz": "Europe/Paris"},
	}, nil)

	requests := make(chan map[string]any, 1)
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/lifecycle" {
			http.NotFound(w, r)
			return
		}
		var got map[string]any
		_ = json.NewDecoder(r.Body).Decode(&got)
		select {
		case requests <- got:
		default:
			t.Errorf("a second lifecycle request: %v", got)
		}
		unlock, err := storage.LockFiber("f")
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		_ = unlock()
		fmt.Fprint(w, "accepted by the daemon\n")
	}))

	out, err := runIn(t, env, dir, "accept", "f")
	if err != nil {
		t.Fatalf("routed accept: %v\n%s", err, out)
	}
	if !strings.Contains(out, "accepted by the daemon") {
		t.Fatalf("daemon answer not relayed: %q", out)
	}
	var got map[string]any
	select {
	case got = <-requests:
	default:
		t.Fatal("the daemon saw no lifecycle request")
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
	t.Parallel()
	env := testEnv(t)
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
	env.Set("SHUTTLE_DAEMON_URL", "http://"+addr)

	if out, err := runIn(t, env, dir, "accept", "f"); err != nil {
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
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusClosed, map[string]any{
		"kind": "standing", "agent": "claude-sonnet", "project_dir": "/srv/work",
		"schedule": map[string]any{"expr": "0 9 * * 1-5", "tz": "Europe/Paris"},
	}, nil)

	release := make(chan struct{})
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
		fmt.Fprint(w, "accepted by the daemon\n")
	}))
	defer close(release)

	a := newApp(env)
	a.daemonLifecycleTimeout = 200 * time.Millisecond

	out, _, err := executeApp(t, a, dir, "accept", "f")
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
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusClosed, oneshot(), nil)

	if _, err := runIn(t, env, dir, "accept", "f", "--local"); err == nil {
		t.Fatal("accept on a oneshot must refuse (standing/pinned only)")
	}
}

func TestShuttleAccept_PinnedReParks(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
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

	if out, err := runIn(t, env, dir, "accept", "f", "--local"); err != nil {
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
	t.Parallel()
	env := testEnv(t)
	ownHost(t, env, "h") // block is host-pinned; own-host must match for the guard to pass
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusActive, map[string]any{
		"kind": "oneshot", "agent": "claude-opus", "host": "h",
		"session_uuid": "abc-123", "dispatched_at": "2026-06-21T00:00:00Z",
	}, nil)

	if out, err := runIn(t, env, dir, "set-model", "f", "claude-sonnet"); err != nil {
		t.Fatalf("set-model: %v\n%s", err, out)
	}
	f := mustRead(t, storage, "f")
	b, _, err := shuttle.BlockOf(f)
	if err != nil {
		t.Fatalf("BlockOf: %v", err)
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
	t.Parallel()
	for _, status := range []string{felt.StatusOpen, felt.StatusActive, felt.StatusClosed} {
		for _, verb := range []string{"set-agent", "set-model"} {
			t.Run(status+"/"+verb, func(t *testing.T) {
				t.Parallel()
				env := testEnv(t)
				dir, storage := newStore(t)
				seedShuttleRole(t, storage, "f", status, map[string]any{
					"kind": "oneshot", "agent": "claude-opus",
					"runtime": map[string]any{"session_uuid": "keep-conversation", "dispatched_at": "2026-06-21T00:00:00Z", "handed_off_at": "2026-06-21T01:00:00Z"},
				}, nil)
				before := mustRead(t, storage, "f")
				args := []string{verb, "f", "claude-sonnet"}
				if verb == "set-agent" {
					args = append(args, "--effort", "high", "--chrome", "--surface", "cli")
				}
				if out, err := runIn(t, env, dir, args...); err != nil {
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
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusActive, oneshot(), nil)

	if _, err := runIn(t, env, dir, "set-model", "f", "no-such-agent"); err == nil {
		t.Fatal("set-model with an unknown agent must fail validation")
	}
}

func TestShuttleSetAgent_AxesSurgical(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusActive, map[string]any{
		"kind": "oneshot", "agent": "claude-opus",
		"session_uuid": "keep-me",
	}, nil)

	if out, err := runIn(t, env, dir, "set-agent", "f", "claude-sonnet", "--effort", "high"); err != nil {
		t.Fatalf("set-agent: %v\n%s", err, out)
	}
	f := mustRead(t, storage, "f")
	b, _, err := shuttle.BlockOf(f)
	if err != nil {
		t.Fatalf("BlockOf: %v", err)
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
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusActive, map[string]any{
		"kind": "oneshot", "agent": "codex-sol", "surface": "cli",
		"session_uuid": "keep-me",
	}, nil)

	// An agent switch within Codex leaves an explicit CLI selection intact.
	if out, err := runIn(t, env, dir, "set-agent", "f", "codex-luna"); err != nil {
		t.Fatalf("set-agent preserving surface: %v\n%s", err, out)
	}
	f := mustRead(t, storage, "f")
	b, _, err := shuttle.BlockOf(f)
	if err != nil || b.Surface != "cli" {
		t.Fatalf("surface after Codex switch = %#v, %v; want cli", b, err)
	}

	if out, err := runIn(t, env, dir, "set-agent", "f", "codex-luna", "--surface", "app"); err != nil {
		t.Fatalf("set-agent app: %v\n%s", err, out)
	}
	f = mustRead(t, storage, "f")
	b, _, err = shuttle.BlockOf(f)
	if err != nil || b.Surface != "app" {
		t.Fatalf("surface after explicit edit = %#v, %v; want app", b, err)
	}
	if _, err := runIn(t, env, dir, "set-agent", "f", "claude-opus"); err == nil {
		t.Fatal("switching an app block away from Codex without choosing cli must fail")
	}
}

// TestShuttleSetModel_KeepsSurfaceConsistentWithAgent: set-model and set-agent
// share one composition rule, so set-model cannot move a surface: app block to
// a non-Codex agent either, which would leave a block set-agent refuses. The
// refusal names the call that does move it.
func TestShuttleSetModel_KeepsSurfaceConsistentWithAgent(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusActive, map[string]any{
		"kind": "oneshot", "agent": "codex-sol", "surface": "app",
	}, nil)

	_, err := runIn(t, env, dir, "set-model", "f", "claude-opus")
	if err == nil || !strings.Contains(err.Error(), "--surface cli") {
		t.Fatalf("set-model to Claude on an app block: err=%v, want a refusal naming --surface cli", err)
	}
	b, _, err := shuttle.BlockOf(mustRead(t, storage, "f"))
	if err != nil || b.Agent != "codex-sol" || b.Surface != "app" {
		t.Fatalf("refused set-model still wrote: %#v, %v", b, err)
	}

	// Within Codex, set-model keeps the surface.
	if out, err := runIn(t, env, dir, "set-model", "f", "codex-luna"); err != nil {
		t.Fatalf("set-model within Codex: %v\n%s", err, out)
	}
	if b, _, err := shuttle.BlockOf(mustRead(t, storage, "f")); err != nil || b.Agent != "codex-luna" || b.Surface != "app" {
		t.Fatalf("after set-model codex-luna: %#v, %v", b, err)
	}

	// The named repair works, and leaves a block set-agent accepts.
	if out, err := runIn(t, env, dir, "set-agent", "f", "claude-opus", "--surface", "cli"); err != nil {
		t.Fatalf("set-agent --surface cli: %v\n%s", err, out)
	}
	if out, err := runIn(t, env, dir, "set-agent", "f", "--effort", "high"); err != nil {
		t.Fatalf("set-agent after the move: %v\n%s", err, out)
	}
}

// ---- uninstall -------------------------------------------------------------

func TestShuttleUninstall_RemovesBlock(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusActive, oneshot(), nil)

	if out, err := runIn(t, env, dir, "uninstall", "f"); err != nil {
		t.Fatalf("uninstall: %v\n%s", err, out)
	}
	if shuttle.HasFacet(mustRead(t, storage, "f")) {
		t.Fatal("uninstall must remove the shuttle: block")
	}
	// Idempotent: a second uninstall is a no-op (nothing to do), not an error.
	if out, err := runIn(t, env, dir, "uninstall", "f"); err != nil {
		t.Fatalf("second uninstall should be a no-op: %v\n%s", err, out)
	}
}

// ---- ownership guard -------------------------------------------------------

func TestShuttleOwnershipGuard_RefusesRemoteOwned(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	ownHost(t, env, "macbook")
	writeRemotesIn(t, env, `{"version":1,"remotes":[]}`)
	env.Set("SHUTTLE_DAEMON_URL", "http://127.0.0.1:1")
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "remote", felt.StatusActive, map[string]any{
		"kind": "oneshot", "agent": "claude-opus", "host": "cineca",
	}, nil)
	before, _ := os.ReadFile(storage.Path("remote"))

	_, err := runIn(t, env, dir, "close", "remote", "--tempered=true")
	if err == nil {
		t.Fatal("close on a cineca-owned fiber from macbook must be refused")
	}
	if !strings.Contains(err.Error(), "nor a discovered tailnet peer") || !strings.Contains(err.Error(), "shuttle close remote") {
		t.Fatalf("expected an actionable routing refusal, got %T: %v", err, err)
	}
	after, _ := os.ReadFile(storage.Path("remote"))
	if string(before) != string(after) {
		t.Fatalf("refused write must leave the mirror byte-identical")
	}
}

func TestShuttleOwnershipGuard_WritesOwnedHere(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	ownHost(t, env, "cineca")
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "owned", felt.StatusActive, map[string]any{
		"kind": "oneshot", "agent": "claude-opus", "host": "cineca",
	}, nil)

	if out, err := runIn(t, env, dir, "close", "owned", "--tempered=true"); err != nil {
		t.Fatalf("close on a fiber owned here must succeed: %v\n%s", err, out)
	}
	if tv := readTempered(mustRead(t, storage, "owned")); tv == nil || !*tv {
		t.Fatal("owned close should write tempered: true")
	}
}

// TestShuttleRetiredAgent_AcceptRefuses covers accept's arming gate: a
// standing role awaiting review with a retired agent must refuse rather than
// silently re-arm.
func TestShuttleRetiredAgent_AcceptRefuses(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusClosed, map[string]any{
		"kind": "standing", "agent": "retired-agent", "project_dir": "/srv/work",
		"schedule": map[string]any{"expr": "0 9 * * 1-5", "tz": "Europe/Paris"},
	}, nil)

	if out, err := runIn(t, env, dir, "accept", "f", "--local"); err == nil {
		t.Fatalf("accept must refuse a retired agent\n%s", out)
	} else if !strings.Contains(err.Error()+out, "retired-agent") {
		t.Fatalf("refusal should name the agent, got: %v\n%s", err, out)
	}
	if mustRead(t, storage, "f").Status != felt.StatusClosed {
		t.Fatal("refused accept must not arm the fiber")
	}
}
