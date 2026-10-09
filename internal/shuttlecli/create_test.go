package shuttlecli

import (
	"os"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

// ---- install ---------------------------------------------------------------

func TestShuttleInstall_Armed(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedPlainFiber(t, storage, "task", "")
	pdir := t.TempDir()

	out, err := runIn(t, env, dir, "install", "task", "--host", "testhost", "--project-dir", pdir, "--model", "claude-opus")
	if err != nil {
		t.Fatalf("install: %v\n%s", err, out)
	}
	f := mustRead(t, storage, "task")
	if f.Status != felt.StatusActive {
		t.Fatalf("armed install should set status active, got %q", f.Status)
	}
	b, ok, err := shuttle.BlockOf(f)
	if err != nil || !ok {
		t.Fatalf("ShuttleBlock: ok=%v err=%v", ok, err)
	}
	if b.Kind != "oneshot" || b.Host != "testhost" || b.Agent != "claude-opus" || b.ProjectDir != pdir {
		t.Fatalf("block fields: %+v", b)
	}
}

func TestShuttleInstall_CodexDefaultsToAppButExplicitCLIWins(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	pdir := t.TempDir()
	seedPlainFiber(t, storage, "app", "")
	seedPlainFiber(t, storage, "cli", "")

	if out, err := runIn(t, env, dir, "install", "app", "--host", "testhost", "--project-dir", pdir, "--model", "codex-sol"); err != nil {
		t.Fatalf("Codex install: %v\n%s", err, out)
	}
	app, _, _ := shuttle.BlockOf(mustRead(t, storage, "app"))
	if app.Surface != "app" {
		t.Fatalf("new Codex surface = %q, want app", app.Surface)
	}

	if out, err := runIn(t, env, dir, "install", "cli", "--host", "testhost", "--project-dir", pdir, "--model", "codex-sol", "--surface", "cli"); err != nil {
		t.Fatalf("explicit CLI install: %v\n%s", err, out)
	}
	cli, _, _ := shuttle.BlockOf(mustRead(t, storage, "cli"))
	if cli.Surface != "cli" {
		t.Fatalf("explicit surface = %q, want cli", cli.Surface)
	}
}

func TestShuttleInstall_Disabled(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedPlainFiber(t, storage, "task", "")

	// --disabled needs no --project-dir.
	if out, err := runIn(t, env, dir, "install", "task", "--host", "testhost", "--disabled"); err != nil {
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
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedPlainFiber(t, storage, "task", "")
	pdir := t.TempDir()

	if out, err := runIn(t, env, dir, "install", "task", "--host", "testhost", "--disabled", "--project-dir", pdir); err != nil {
		t.Fatalf("install --disabled --project-dir: %v\n%s", err, out)
	}
	b, ok, err := shuttle.BlockOf(mustRead(t, storage, "task"))
	if err != nil || !ok {
		t.Fatalf("ShuttleBlock: ok=%v err=%v", ok, err)
	}
	if b.ProjectDir != pdir {
		t.Fatalf("project_dir = %q, want %q — an explicit flag must not be dropped", b.ProjectDir, pdir)
	}
}

func TestShuttleInstall_RequiresProjectDirWhenArmed(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedPlainFiber(t, storage, "task", "")

	if _, err := runIn(t, env, dir, "install", "task", "--host", "testhost"); err == nil {
		t.Fatal("armed install without --project-dir must fail")
	}
}

// TestShuttleCreate_RefusesExistingBlock is the one policy the create
// verbs share: they CREATE, so a fiber that already carries a block is a
// refusal — and the refusal routes the caller to the verb that edits in place.
// `shuttle status <fiber>` is the report on an existing block.
func TestShuttleCreate_RefusesExistingBlock(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name string
		args []string
	}{
		{"install", []string{"install", "task"}},
		{"repeat", []string{"repeat", "task", "--schedule", "0 9 * * 1-5"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			ownHost(t, env, "testhost")
			dir, storage := newStore(t)
			pdir := t.TempDir()
			seedShuttleRole(t, storage, "task", felt.StatusActive, map[string]any{
				"kind": "oneshot", "agent": "claude-opus", "host": "testhost", "project_dir": pdir,
			}, nil)
			before, _ := os.ReadFile(storage.Path("task"))

			args := append(append([]string{}, tc.args...), "--project-dir", pdir)
			out, err := runIn(t, env, dir, args...)
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

// ---- repeat ----------------------------------------------------------------

func TestShuttleRepeat_Standing(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedPlainFiber(t, storage, "role", "")
	pdir := t.TempDir()

	out, err := runIn(t, env, dir, "repeat", "role",
		"--host", "testhost", "--schedule", "0 9 * * 1-5", "--tz", "Europe/Paris", "--project-dir", pdir, "--model", "claude-sonnet")
	if err != nil {
		t.Fatalf("repeat: %v\n%s", err, out)
	}
	f := mustRead(t, storage, "role")
	if f.Status != felt.StatusActive {
		t.Fatalf("standing constitution should be born active, got %q", f.Status)
	}
	b, ok, err := shuttle.BlockOf(f)
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
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedPlainFiber(t, storage, "role", "")
	pdir := t.TempDir()

	if _, err := runIn(t, env, dir, "repeat", "role",
		"--host", "testhost", "--schedule", "not a cron", "--project-dir", pdir); err == nil {
		t.Fatal("repeat with an invalid cron must fail validation")
	}
}

// ---- regressions from adversarial verification ----------------------------

// repeat never rewrites an existing block, so it has no daemon-owned runtime
// keys to preserve; TestShuttleReshapeVerb_StandingToOneshotOnClosedFiber
// asserts they survive a kind change.

// TestShuttleCreate_MalformedBlockErrors proves install/repeat surface a
// clean error (not a nil-deref panic) on a shuttle: value that is a mapping but
// fails the typed decode — e.g. a hand-edited schedule written as a scalar.
func TestShuttleCreate_MalformedBlockErrors(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	pdir := t.TempDir()
	seedShuttleRole(t, storage, "bad", felt.StatusActive, map[string]any{
		"kind": "standing", "schedule": "not-a-mapping",
	}, nil)

	cases := [][]string{
		{"install", "bad"},
		{"repeat", "bad", "--host", "testhost", "--schedule", "0 9 * * 1-5", "--project-dir", pdir},
	}
	for _, args := range cases {
		if _, err := runIn(t, env, dir, args...); err == nil {
			t.Fatalf("%v on a malformed block must error cleanly (got nil — a panic would have crashed the test)", args)
		}
	}
}

// TestShuttleRepeat_RefusesRemoteOwned proves the ownership guard is checked
// BEFORE the already-has-a-block refusal: a cineca-owned role addressed from
// macbook gets the truer error (the edit verbs it would be pointed at would
// refuse on the same grounds), and the mirror stays byte-identical.
func TestShuttleRepeat_RefusesRemoteOwned(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	ownHost(t, env, "macbook")
	dir, storage := newStore(t)
	pdir := t.TempDir()
	seedShuttleRole(t, storage, "remote", felt.StatusActive, map[string]any{
		"kind": "standing", "agent": "claude-opus", "host": "cineca",
		"schedule": map[string]any{"expr": "0 8 * * *", "tz": "UTC"},
	}, nil)
	before, _ := os.ReadFile(storage.Path("remote"))

	_, err := runIn(t, env, dir, "repeat", "remote", "--schedule", "0 9 * * 1-5", "--project-dir", pdir)
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
