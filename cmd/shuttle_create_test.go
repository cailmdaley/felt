package cmd

import (
	"os"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

// seedPlainFiber writes a pure note (no shuttle: block) with the given status, so
// the create verbs have a fiber to attach a block to.
func seedPlainFiber(t *testing.T, storage *felt.Storage, id, status string) {
	t.Helper()
	f := &felt.Felt{ID: id, Name: id, Status: status, CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}
	if err := storage.Write(f); err != nil {
		t.Fatalf("Write %s: %v", id, err)
	}
}

// ---- install ---------------------------------------------------------------

func TestShuttleInstall_Armed(t *testing.T) {
	defer saveShuttleGlobals()()
	dir, storage := newShuttleStore(t)
	seedPlainFiber(t, storage, "task", "")
	pdir := t.TempDir()

	out, err := runCommand(t, dir, "shuttle", "install", "task", "--host", "testhost", "--project-dir", pdir, "--model", "claude-opus")
	if err != nil {
		t.Fatalf("install: %v\n%s", err, out)
	}
	f := mustRead(t, storage, "task")
	if f.Status != felt.StatusActive {
		t.Fatalf("armed install should set status active, got %q", f.Status)
	}
	b, ok, err := f.ShuttleBlock()
	if err != nil || !ok {
		t.Fatalf("ShuttleBlock: ok=%v err=%v", ok, err)
	}
	if b.Kind != "oneshot" || b.Host != "testhost" || b.Agent != "claude-opus" || b.ProjectDir != pdir {
		t.Fatalf("block fields: %+v", b)
	}
}

func TestShuttleInstall_Disabled(t *testing.T) {
	defer saveShuttleGlobals()()
	dir, storage := newShuttleStore(t)
	seedPlainFiber(t, storage, "task", "")

	// --disabled needs no --project-dir.
	if out, err := runCommand(t, dir, "shuttle", "install", "task", "--host", "testhost", "--disabled"); err != nil {
		t.Fatalf("install --disabled: %v\n%s", err, out)
	}
	if mustRead(t, storage, "task").Status != felt.StatusOpen {
		t.Fatal("--disabled should land at status: open")
	}
}

func TestShuttleInstall_RequiresProjectDirWhenArmed(t *testing.T) {
	defer saveShuttleGlobals()()
	dir, storage := newShuttleStore(t)
	seedPlainFiber(t, storage, "task", "")

	if _, err := runCommand(t, dir, "shuttle", "install", "task", "--host", "testhost"); err == nil {
		t.Fatal("armed install without --project-dir must fail")
	}
}

func TestShuttleInstall_IdempotentAndConflict(t *testing.T) {
	defer saveShuttleGlobals()()
	dir, storage := newShuttleStore(t)
	pdir := t.TempDir()
	seedShuttleRole(t, storage, "task", felt.StatusActive, map[string]any{
		"kind": "oneshot", "agent": "claude-opus", "host": "testhost", "project_dir": pdir,
	}, nil)

	// Plain re-install: idempotent state report, exit 0, no error.
	out, err := runCommand(t, dir, "shuttle", "install", "task")
	if err != nil {
		t.Fatalf("idempotent install should exit 0: %v\n%s", err, out)
	}
	if !strings.Contains(out, "already has a shuttle: block") {
		t.Fatalf("expected idempotent report, got:\n%s", out)
	}

	// Conflicting --model: error pointing at set-model.
	if _, err := runCommand(t, dir, "shuttle", "install", "task", "--model", "claude-sonnet"); err == nil {
		t.Fatal("install with a conflicting --model must error")
	}
}

func TestShuttleInstall_RefusesClosed(t *testing.T) {
	defer saveShuttleGlobals()()
	dir, storage := newShuttleStore(t)
	seedPlainFiber(t, storage, "task", felt.StatusClosed)
	pdir := t.TempDir()

	if _, err := runCommand(t, dir, "shuttle", "install", "task", "--host", "testhost", "--project-dir", pdir); err == nil {
		t.Fatal("armed install on a closed fiber must refuse")
	}
}

// ---- repeat ----------------------------------------------------------------

func TestShuttleRepeat_Standing(t *testing.T) {
	defer saveShuttleGlobals()()
	dir, storage := newShuttleStore(t)
	seedPlainFiber(t, storage, "role", "")
	pdir := t.TempDir()

	out, err := runCommand(t, dir, "shuttle", "repeat", "role",
		"--host", "testhost", "--schedule", "0 9 * * 1-5", "--tz", "Europe/Paris", "--project-dir", pdir, "--model", "claude-sonnet")
	if err != nil {
		t.Fatalf("repeat: %v\n%s", err, out)
	}
	f := mustRead(t, storage, "role")
	if f.Status != felt.StatusActive {
		t.Fatalf("standing role should be born active, got %q", f.Status)
	}
	b, ok, err := f.ShuttleBlock()
	if err != nil || !ok {
		t.Fatalf("ShuttleBlock: ok=%v err=%v", ok, err)
	}
	if b.Kind != "standing" || b.Schedule == nil || b.Schedule.Expr != "0 9 * * 1-5" || b.Schedule.TZ != "Europe/Paris" {
		t.Fatalf("schedule not set: %+v", b)
	}
	if !strings.Contains(out, "next due:") {
		t.Fatalf("repeat should report next due, got:\n%s", out)
	}
}

func TestShuttleRepeat_RejectsBadCron(t *testing.T) {
	defer saveShuttleGlobals()()
	dir, storage := newShuttleStore(t)
	seedPlainFiber(t, storage, "role", "")
	pdir := t.TempDir()

	if _, err := runCommand(t, dir, "shuttle", "repeat", "role",
		"--host", "testhost", "--schedule", "not a cron", "--project-dir", pdir); err == nil {
		t.Fatal("repeat with an invalid cron must fail validation")
	}
}

// ---- pin -------------------------------------------------------------------

func TestShuttlePin_Parked(t *testing.T) {
	defer saveShuttleGlobals()()
	dir, storage := newShuttleStore(t)
	seedPlainFiber(t, storage, "hub", "")
	pdir := t.TempDir()

	out, err := runCommand(t, dir, "shuttle", "pin", "hub", "--host", "testhost", "--project-dir", pdir)
	if err != nil {
		t.Fatalf("pin: %v\n%s", err, out)
	}
	f := mustRead(t, storage, "hub")
	if f.Status != felt.StatusOpen {
		t.Fatalf("pinned role rests at status: open, got %q", f.Status)
	}
	b, _, _ := f.ShuttleBlock()
	if b == nil || b.Kind != "pinned" {
		t.Fatalf("pinned block: %+v", b)
	}
}

func TestShuttlePin_RefusesExistingBlock(t *testing.T) {
	defer saveShuttleGlobals()()
	dir, storage := newShuttleStore(t)
	seedShuttleRole(t, storage, "hub", felt.StatusActive, oneshot(), nil)
	pdir := t.TempDir()

	if _, err := runCommand(t, dir, "shuttle", "pin", "hub", "--host", "testhost", "--project-dir", pdir); err == nil {
		t.Fatal("pin on a fiber that already has a block must refuse")
	}
}

// ---- regressions from adversarial verification ----------------------------

// TestShuttleRepeat_PreservesRuntimeKeys is the regression for the
// repeat-over-existing clobber: re-defining a live standing role's schedule must
// keep the daemon-owned continuation keys (shuttle preserves them via
// mergeUnknownShuttleFields; the felt port now does via SetShuttleConfig).
func TestShuttleRepeat_PreservesRuntimeKeys(t *testing.T) {
	defer saveShuttleGlobals()()
	dir, storage := newShuttleStore(t)
	pdir := t.TempDir()
	// A live standing role carrying continuation state, host-less (guard fail-open).
	seedShuttleRole(t, storage, "role", felt.StatusActive, map[string]any{
		"kind": "standing", "agent": "claude-opus",
		"schedule":     map[string]any{"expr": "0 8 * * *", "tz": "UTC"},
		"session_uuid": "keep-uuid", "dispatched_at": "2026-06-21T00:00:00Z",
	}, nil)

	// Redefine the recurrence; --model omitted so the agent is inherited.
	if out, err := runCommand(t, dir, "shuttle", "repeat", "role",
		"--host", "testhost", "--schedule", "0 9 * * 1-5", "--tz", "Europe/Paris", "--project-dir", pdir); err != nil {
		t.Fatalf("repeat: %v\n%s", err, out)
	}
	f := mustRead(t, storage, "role")
	b, ok, err := f.ShuttleBlock()
	if err != nil || !ok {
		t.Fatalf("ShuttleBlock: ok=%v err=%v", ok, err)
	}
	if b.Schedule == nil || b.Schedule.Expr != "0 9 * * 1-5" || b.Agent != "claude-opus" {
		t.Fatalf("new config / inherited agent not applied: %+v", b)
	}
	raw, _ := os.ReadFile(storage.Path("role"))
	for _, want := range []string{"session_uuid: keep-uuid", "dispatched_at:", "2026-06-21T00:00:00Z"} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("repeat clobbered a runtime key: missing %q in\n%s", want, raw)
		}
	}
}

// TestShuttleCreate_MalformedBlockErrors proves install/repeat/pin surface a
// clean error (not a nil-deref panic) on a shuttle: value that is a mapping but
// fails the typed decode — e.g. a hand-edited schedule written as a scalar.
func TestShuttleCreate_MalformedBlockErrors(t *testing.T) {
	defer saveShuttleGlobals()()
	dir, storage := newShuttleStore(t)
	pdir := t.TempDir()
	seedShuttleRole(t, storage, "bad", felt.StatusActive, map[string]any{
		"kind": "standing", "schedule": "not-a-mapping",
	}, nil)

	cases := [][]string{
		{"shuttle", "install", "bad"},
		{"shuttle", "repeat", "bad", "--host", "testhost", "--schedule", "0 9 * * 1-5", "--project-dir", pdir},
		{"shuttle", "pin", "bad", "--host", "testhost", "--project-dir", pdir},
	}
	for _, args := range cases {
		if _, err := runCommand(t, dir, args...); err == nil {
			t.Fatalf("%v on a malformed block must error cleanly (got nil — a panic would have crashed the test)", args)
		}
	}
}

// TestShuttleRepeat_RefusesRemoteOwned proves repeat (the one create verb that
// overwrites) passes the ownership guard: re-defining a cineca-owned role from
// macbook must refuse and leave the mirror byte-identical.
func TestShuttleRepeat_RefusesRemoteOwned(t *testing.T) {
	defer saveShuttleGlobals()()
	withOwnHost(t, "macbook")
	dir, storage := newShuttleStore(t)
	pdir := t.TempDir()
	seedShuttleRole(t, storage, "remote", felt.StatusActive, map[string]any{
		"kind": "standing", "agent": "claude-opus", "host": "cineca",
		"schedule": map[string]any{"expr": "0 8 * * *", "tz": "UTC"},
	}, nil)
	before, _ := os.ReadFile(storage.Path("remote"))

	_, err := runCommand(t, dir, "shuttle", "repeat", "remote", "--schedule", "0 9 * * 1-5", "--project-dir", pdir)
	if err == nil {
		t.Fatal("repeat on a cineca-owned role from macbook must be refused")
	}
	if _, ok := err.(ownerMismatchError); !ok {
		t.Fatalf("expected ownerMismatchError, got %T: %v", err, err)
	}
	after, _ := os.ReadFile(storage.Path("remote"))
	if string(before) != string(after) {
		t.Fatal("refused repeat must leave the mirror byte-identical")
	}
}
