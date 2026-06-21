package cmd

import (
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
