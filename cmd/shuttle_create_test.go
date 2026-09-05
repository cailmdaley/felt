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
	dir, storage := newStore(t)
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
	dir, storage := newStore(t)
	seedPlainFiber(t, storage, "task", "")

	// --disabled needs no --project-dir.
	if out, err := runCommand(t, dir, "shuttle", "install", "task", "--host", "testhost", "--disabled"); err != nil {
		t.Fatalf("install --disabled: %v\n%s", err, out)
	}
	if mustRead(t, storage, "task").Status != felt.StatusOpen {
		t.Fatal("--disabled should land at status: open")
	}
}

// TestShuttleInstall_DisabledKeepsExplicitProjectDir: a draft needs no cwd, but
// one passed explicitly must survive. The board's Promote button installs
// --disabled WITH a project_dir and nothing later supplies one, so dropping it
// would arm a role on resume that the poller disqualifies for having no usable
// project_dir — armed, and silently never dispatched.
func TestShuttleInstall_DisabledKeepsExplicitProjectDir(t *testing.T) {
	defer saveShuttleGlobals()()
	dir, storage := newStore(t)
	seedPlainFiber(t, storage, "task", "")
	pdir := t.TempDir()

	if out, err := runCommand(t, dir, "shuttle", "install", "task", "--host", "testhost", "--disabled", "--project-dir", pdir); err != nil {
		t.Fatalf("install --disabled --project-dir: %v\n%s", err, out)
	}
	b, ok, err := mustRead(t, storage, "task").ShuttleBlock()
	if err != nil || !ok {
		t.Fatalf("ShuttleBlock: ok=%v err=%v", ok, err)
	}
	if b.ProjectDir != pdir {
		t.Fatalf("project_dir = %q, want %q — an explicit flag must not be dropped", b.ProjectDir, pdir)
	}
}

func TestShuttleInstall_RequiresProjectDirWhenArmed(t *testing.T) {
	defer saveShuttleGlobals()()
	dir, storage := newStore(t)
	seedPlainFiber(t, storage, "task", "")

	if _, err := runCommand(t, dir, "shuttle", "install", "task", "--host", "testhost"); err == nil {
		t.Fatal("armed install without --project-dir must fail")
	}
}

// TestShuttleCreate_RefusesExistingBlock is the one policy the three create
// verbs now share: they CREATE, so a fiber that already carries a block is a
// refusal — and the refusal routes the caller to the verb that edits in place.
// (install used to be idempotent here, reporting the block and exiting 0; that
// second meaning is gone, and `felt shuttle status <fiber>` is the report.)
func TestShuttleCreate_RefusesExistingBlock(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
	}{
		{"install", []string{"install", "task"}},
		{"repeat", []string{"repeat", "task", "--schedule", "0 9 * * 1-5"}},
		{"pin", []string{"pin", "task"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			defer saveShuttleGlobals()()
			withOwnHost(t, "testhost")
			dir, storage := newStore(t)
			pdir := t.TempDir()
			seedShuttleRole(t, storage, "task", felt.StatusActive, map[string]any{
				"kind": "oneshot", "agent": "claude-opus", "host": "testhost", "project_dir": pdir,
			}, nil)
			before, _ := os.ReadFile(storage.Path("task"))

			args := append(append([]string{"shuttle"}, tc.args...), "--project-dir", pdir)
			out, err := runCommand(t, dir, args...)
			if err == nil {
				t.Fatalf("%s over an existing block must refuse; out=%s", tc.name, out)
			}
			// The refusal has to name the surgical verbs, or it just blocks the user.
			for _, verb := range []string{"reshape", "set-model", "uninstall"} {
				if !strings.Contains(err.Error(), verb) {
					t.Fatalf("refusal should point at %s; err=%v", verb, err)
				}
			}
			after, _ := os.ReadFile(storage.Path("task"))
			if string(before) != string(after) {
				t.Fatalf("refused %s must leave the fiber byte-identical", tc.name)
			}
		})
	}
}

func TestShuttleInstall_RefusesClosed(t *testing.T) {
	defer saveShuttleGlobals()()
	dir, storage := newStore(t)
	seedPlainFiber(t, storage, "task", felt.StatusClosed)
	pdir := t.TempDir()

	if _, err := runCommand(t, dir, "shuttle", "install", "task", "--host", "testhost", "--project-dir", pdir); err == nil {
		t.Fatal("armed install on a closed fiber must refuse")
	}
}

// ---- repeat ----------------------------------------------------------------

func TestShuttleRepeat_Standing(t *testing.T) {
	defer saveShuttleGlobals()()
	dir, storage := newStore(t)
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
	dir, storage := newStore(t)
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
	dir, storage := newStore(t)
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

// ---- regressions from adversarial verification ----------------------------

// The runtime-key guarantee that TestShuttleRepeat_PreservesRuntimeKeys used to
// carry belongs to `felt shuttle reshape` now: repeat no longer rewrites an
// existing block, so it has no daemon-owned keys to preserve. Its successor is
// TestShuttleReshapeVerb_StandingToOneshotOnClosedFiber, which asserts the
// runtime keys survive a kind change.

// TestShuttleCreate_MalformedBlockErrors proves install/repeat/pin surface a
// clean error (not a nil-deref panic) on a shuttle: value that is a mapping but
// fails the typed decode — e.g. a hand-edited schedule written as a scalar.
func TestShuttleCreate_MalformedBlockErrors(t *testing.T) {
	defer saveShuttleGlobals()()
	dir, storage := newStore(t)
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

// TestShuttleRepeat_RefusesRemoteOwned proves the ownership guard is checked
// BEFORE the already-has-a-block refusal: a cineca-owned role addressed from
// macbook gets the truer error (the edit verbs it would be pointed at would
// refuse on the same grounds), and the mirror stays byte-identical.
func TestShuttleRepeat_RefusesRemoteOwned(t *testing.T) {
	defer saveShuttleGlobals()()
	withOwnHost(t, "macbook")
	dir, storage := newStore(t)
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
