package cmd

import (
	"os"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

// ---- shared lifecycle test helpers -----------------------------------------

// saveShuttleGlobals resets the lifecycle verbs' flag globals and Changed state
// between runs (cobra persists both across Execute), restoring on cleanup.
func saveShuttleGlobals() func() {
	prev := struct {
		pauseNoKill       bool
		closeTempered     string
		reopenAsDraft     bool
		setOutcomeValue   string
		acceptKeepOutcome bool
		setAgentEffort    string
		setAgentChrome    bool
		installModel      string
		installProjectDir string
		installHost       string
		installDisabled   bool
		repeatSchedule    string
		repeatTZ          string
		repeatModel       string
		repeatProjectDir  string
		repeatHost        string
		pinModel          string
		pinProjectDir     string
		pinHost           string
	}{
		pauseNoKill, closeTempered, reopenAsDraft, setOutcomeValue, acceptKeepOutcome, setAgentEffort, setAgentChrome,
		installModel, installProjectDir, installHost, installDisabled,
		repeatSchedule, repeatTZ, repeatModel, repeatProjectDir, repeatHost,
		pinModel, pinProjectDir, pinHost,
	}

	pauseNoKill = false
	closeTempered = ""
	reopenAsDraft = false
	setOutcomeValue = ""
	acceptKeepOutcome = false
	setAgentEffort = ""
	setAgentChrome = false
	installModel, installProjectDir, installHost, installDisabled = "", "", "", false
	repeatSchedule, repeatTZ, repeatModel, repeatProjectDir, repeatHost = "", "", "", "", ""
	pinModel, pinProjectDir, pinHost = "", "", ""

	pauseCmd.ResetFlags()
	closeCmd.ResetFlags()
	reopenCmd.ResetFlags()
	setOutcomeCmd.ResetFlags()
	acceptCmd.ResetFlags()
	setAgentCmd.ResetFlags()
	registerShuttleLifecycleFlags()
	installCmd.ResetFlags()
	repeatCmd.ResetFlags()
	pinCmd.ResetFlags()
	registerShuttleCreateFlags()

	return func() {
		pauseNoKill = prev.pauseNoKill
		closeTempered = prev.closeTempered
		reopenAsDraft = prev.reopenAsDraft
		setOutcomeValue = prev.setOutcomeValue
		acceptKeepOutcome = prev.acceptKeepOutcome
		setAgentEffort = prev.setAgentEffort
		setAgentChrome = prev.setAgentChrome
		installModel, installProjectDir, installHost, installDisabled = prev.installModel, prev.installProjectDir, prev.installHost, prev.installDisabled
		repeatSchedule, repeatTZ, repeatModel, repeatProjectDir, repeatHost = prev.repeatSchedule, prev.repeatTZ, prev.repeatModel, prev.repeatProjectDir, prev.repeatHost
		pinModel, pinProjectDir, pinHost = prev.pinModel, prev.pinProjectDir, prev.pinHost
	}
}

func newShuttleStore(t *testing.T) (string, *felt.Storage) {
	t.Helper()
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	return dir, storage
}

// seedShuttleRole seeds a fiber carrying a shuttle: block plus the requested
// felt-native status and optional tempered verdict, straight through storage.
func seedShuttleRole(t *testing.T, storage *felt.Storage, id, status string, block map[string]any, tempered *bool) {
	t.Helper()
	f := &felt.Felt{ID: id, Name: id, Status: status, CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}
	if err := f.SetExtraField("shuttle", block); err != nil {
		t.Fatalf("SetExtraField shuttle: %v", err)
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
	return map[string]any{"kind": "oneshot", "agent": "claude-opus"}
}

// ---- close -----------------------------------------------------------------

func TestShuttleClose_Tempered(t *testing.T) {
	defer saveShuttleGlobals()()
	dir, storage := newShuttleStore(t)
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
	defer saveShuttleGlobals()()
	dir, storage := newShuttleStore(t)
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
	defer saveShuttleGlobals()()
	dir, storage := newShuttleStore(t)
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
	defer saveShuttleGlobals()()
	dir, storage := newShuttleStore(t)
	seedShuttleRole(t, storage, "task", felt.StatusActive, oneshot(), nil)
	killed := withStubbedTmux(t, map[string]bool{"task-shuttle": true})

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
	defer saveShuttleGlobals()()
	dir, storage := newShuttleStore(t)
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
	defer saveShuttleGlobals()()
	dir, storage := newShuttleStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusClosed, oneshot(), nil)

	if out, err := runCommand(t, dir, "shuttle", "reopen", "f", "--as-draft"); err != nil {
		t.Fatalf("reopen --as-draft: %v\n%s", err, out)
	}
	if mustRead(t, storage, "f").Status != felt.StatusOpen {
		t.Fatal("--as-draft must reopen to status: open")
	}
}

// ---- resume ----------------------------------------------------------------

func TestShuttleResume_DraftToActive(t *testing.T) {
	defer saveShuttleGlobals()()
	dir, storage := newShuttleStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusOpen, oneshot(), nil)

	if out, err := runCommand(t, dir, "shuttle", "resume", "f"); err != nil {
		t.Fatalf("resume: %v\n%s", err, out)
	}
	if mustRead(t, storage, "f").Status != felt.StatusActive {
		t.Fatal("resume should arm to active")
	}
}

func TestShuttleResume_RefusesClosed(t *testing.T) {
	defer saveShuttleGlobals()()
	dir, storage := newShuttleStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusClosed, oneshot(), nil)

	if _, err := runCommand(t, dir, "shuttle", "resume", "f"); err == nil {
		t.Fatal("resume on a closed oneshot must refuse (use reopen)")
	}
}

func TestShuttleResume_StandingAwaitingOfflineFallback(t *testing.T) {
	defer saveShuttleGlobals()()
	t.Setenv("SHUTTLE_LIFECYCLE_OFFLINE", "1")
	dir, storage := newShuttleStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusClosed, map[string]any{
		"kind": "standing", "agent": "claude-sonnet",
		"schedule": map[string]any{"expr": "0 9 * * 1-5", "tz": "Europe/Paris"},
	}, nil)

	if out, err := runCommand(t, dir, "shuttle", "resume", "f"); err != nil {
		t.Fatalf("resume (offline): %v\n%s", err, out)
	}
	f := mustRead(t, storage, "f")
	if f.Status != felt.StatusActive || f.ClosedAt != nil {
		t.Fatalf("offline re-arm should set active + clear closed-at, got status=%q closedAt=%v", f.Status, f.ClosedAt)
	}
}

// ---- set-outcome -----------------------------------------------------------

func TestShuttleSetOutcome(t *testing.T) {
	defer saveShuttleGlobals()()
	dir, storage := newShuttleStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusActive, oneshot(), nil)

	if out, err := runCommand(t, dir, "shuttle", "set-outcome", "f", "--outcome", "Blocked: waiting on token"); err != nil {
		t.Fatalf("set-outcome: %v\n%s", err, out)
	}
	if got := mustRead(t, storage, "f").Outcome; got != "Blocked: waiting on token" {
		t.Fatalf("outcome = %q", got)
	}
}

// ---- accept ----------------------------------------------------------------

func TestShuttleAccept_OfflineRearmsAndClearsOutcome(t *testing.T) {
	defer saveShuttleGlobals()()
	t.Setenv("SHUTTLE_LIFECYCLE_OFFLINE", "1")
	dir, storage := newShuttleStore(t)
	// Awaiting review: standing, closed, untempered, with a prior outcome.
	f := &felt.Felt{ID: "f", Name: "f", Status: felt.StatusClosed, Outcome: "prior digest", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}
	if err := f.SetExtraField("shuttle", map[string]any{
		"kind": "standing", "agent": "claude-sonnet",
		"schedule": map[string]any{"expr": "0 9 * * 1-5", "tz": "Europe/Paris"},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := storage.Write(f); err != nil {
		t.Fatalf("write: %v", err)
	}

	if out, err := runCommand(t, dir, "shuttle", "accept", "f"); err != nil {
		t.Fatalf("accept (offline): %v\n%s", err, out)
	}
	got := mustRead(t, storage, "f")
	if got.Status != felt.StatusActive {
		t.Fatalf("status = %q, want active", got.Status)
	}
	if got.Outcome != "" {
		t.Fatalf("accept should clear outcome, got %q", got.Outcome)
	}
}

func TestShuttleAccept_RequiresAwaiting(t *testing.T) {
	defer saveShuttleGlobals()()
	t.Setenv("SHUTTLE_LIFECYCLE_OFFLINE", "1")
	dir, storage := newShuttleStore(t)
	// Active (not awaiting) standing role → accept refuses.
	seedShuttleRole(t, storage, "f", felt.StatusActive, map[string]any{
		"kind": "standing", "agent": "claude-sonnet",
		"schedule": map[string]any{"expr": "0 9 * * 1-5", "tz": "Europe/Paris"},
	}, nil)

	if _, err := runCommand(t, dir, "shuttle", "accept", "f"); err == nil {
		t.Fatal("accept on a non-awaiting role must refuse")
	}
}

func TestShuttleAccept_RejectsOneshot(t *testing.T) {
	defer saveShuttleGlobals()()
	t.Setenv("SHUTTLE_LIFECYCLE_OFFLINE", "1")
	dir, storage := newShuttleStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusClosed, oneshot(), nil)

	if _, err := runCommand(t, dir, "shuttle", "accept", "f"); err == nil {
		t.Fatal("accept on a oneshot must refuse (standing only)")
	}
}

// ---- set-model / set-agent -------------------------------------------------

func TestShuttleSetModel_PreservesRuntimeKeys(t *testing.T) {
	defer saveShuttleGlobals()()
	withOwnHost(t, "h") // block is host-pinned; own-host must match for the guard to pass
	dir, storage := newShuttleStore(t)
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

func TestShuttleSetModel_RejectsUnknownAgent(t *testing.T) {
	defer saveShuttleGlobals()()
	dir, storage := newShuttleStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusActive, oneshot(), nil)

	if _, err := runCommand(t, dir, "shuttle", "set-model", "f", "no-such-agent"); err == nil {
		t.Fatal("set-model with an unknown agent must fail validation")
	}
}

func TestShuttleSetAgent_AxesSurgical(t *testing.T) {
	defer saveShuttleGlobals()()
	dir, storage := newShuttleStore(t)
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

// ---- uninstall -------------------------------------------------------------

func TestShuttleUninstall_RemovesBlock(t *testing.T) {
	defer saveShuttleGlobals()()
	dir, storage := newShuttleStore(t)
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
	defer saveShuttleGlobals()()
	withOwnHost(t, "macbook")
	dir, storage := newShuttleStore(t)
	seedShuttleRole(t, storage, "remote", felt.StatusActive, map[string]any{
		"kind": "oneshot", "agent": "claude-opus", "host": "cineca",
	}, nil)
	before, _ := os.ReadFile(storage.Path("remote"))

	_, err := runCommand(t, dir, "shuttle", "close", "remote", "--tempered=true")
	if err == nil {
		t.Fatal("close on a cineca-owned fiber from macbook must be refused")
	}
	if _, ok := err.(ownerMismatchError); !ok {
		t.Fatalf("expected ownerMismatchError, got %T: %v", err, err)
	}
	after, _ := os.ReadFile(storage.Path("remote"))
	if string(before) != string(after) {
		t.Fatalf("refused write must leave the mirror byte-identical")
	}
}

func TestShuttleOwnershipGuard_WritesOwnedHere(t *testing.T) {
	defer saveShuttleGlobals()()
	withOwnHost(t, "cineca")
	dir, storage := newShuttleStore(t)
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
