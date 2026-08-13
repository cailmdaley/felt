package cmd

import (
	"os"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

// Tests for `felt shuttle reshape` — the surgical kind setter. Its whole reason
// to exist is that changing a role's kind is a CONFIG edit, so these tests pin
// the two properties the create-verb detour could not give: the lifecycle
// (status / tempered / closed-at) is never touched, and the daemon-owned
// runtime keys survive.
//
// They also carry the atomicity guarantee the retired `--reshape` flag used to
// own: a rejected shape change leaves the fiber byte-identical on disk. The
// no-clobber default it also owned is now the create verbs' one refusal policy,
// tested in TestShuttleCreate_RefusesExistingBlock.

// standingRole is the seed block these tests reshape from.
func standingRole(pdir string) map[string]any {
	return map[string]any{
		"kind": "standing", "host": "testhost", "project_dir": pdir, "agent": "claude-sonnet",
		"schedule": map[string]any{"expr": "0 8 * * *", "tz": "Europe/Paris"},
		"runtime":  map[string]any{"session_uuid": "deadbeef-1234"},
	}
}

// TestShuttleReshapeVerb_StandingToOneshotOnClosedFiber is the bug this verb
// closes: a role parked in Awaiting review changes kind in place, keeps its
// verdict and its runtime keys, and sheds the now-meaningless schedule.
func TestShuttleReshapeVerb_StandingToOneshotOnClosedFiber(t *testing.T) {
	defer saveShuttleGlobals()()
	withOwnHost(t, "testhost")
	dir, storage := newShuttleStore(t)
	yes := true
	seedShuttleRole(t, storage, "role", felt.StatusClosed, standingRole(t.TempDir()), &yes)

	out, err := runCommand(t, dir, "shuttle", "reshape", "role", "oneshot")
	if err != nil {
		t.Fatalf("reshape: %v\n%s", err, out)
	}
	f := mustRead(t, storage, "role")
	if f.Status != felt.StatusClosed {
		t.Fatalf("reshape moved status: got %q, want closed", f.Status)
	}
	if tv := readTempered(f); tv == nil || !*tv {
		t.Fatalf("reshape lost the verdict: tempered=%v", tv)
	}
	b, ok, err := f.ShuttleBlock()
	if err != nil || !ok {
		t.Fatalf("ShuttleBlock: ok=%v err=%v", ok, err)
	}
	if b.Kind != "oneshot" {
		t.Fatalf("kind = %q, want oneshot", b.Kind)
	}
	if b.Schedule != nil {
		t.Fatalf("oneshot must not carry a schedule: %+v", b.Schedule)
	}
	if b.Agent != "claude-sonnet" || b.Host != "testhost" {
		t.Fatalf("reshape disturbed sibling config: %+v", b)
	}
	raw, err := f.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if !strings.Contains(string(raw), "deadbeef-1234") {
		t.Fatalf("reshape lost the runtime session_uuid:\n%s", raw)
	}
	if strings.Contains(string(raw), "schedule") {
		t.Fatalf("schedule key survived the reshape:\n%s", raw)
	}
}

// TestShuttleReshapeVerb_ToStandingRequiresSchedule: nothing to echo, so the
// standing target must ask for one rather than write an invalid block.
func TestShuttleReshapeVerb_ToStandingRequiresSchedule(t *testing.T) {
	defer saveShuttleGlobals()()
	withOwnHost(t, "testhost")
	dir, storage := newShuttleStore(t)
	seedShuttleRole(t, storage, "role", felt.StatusActive, oneshot(), nil)

	out, err := runCommand(t, dir, "shuttle", "reshape", "role", "standing")
	if err == nil {
		t.Fatalf("reshape to standing without a schedule must fail; out=%s", out)
	}
	if !strings.Contains(err.Error(), "--schedule") {
		t.Fatalf("error should point at --schedule; err=%v", err)
	}
	b, _, _ := mustRead(t, storage, "role").ShuttleBlock()
	if b.Kind != "oneshot" {
		t.Fatalf("failed reshape mutated the block: %+v", b)
	}
}

// TestShuttleReshapeVerb_ToStandingWithSchedule: the schedule lands, tz falls
// back to UTC when the block has none to echo, and the next occurrence prints.
func TestShuttleReshapeVerb_ToStandingWithSchedule(t *testing.T) {
	defer saveShuttleGlobals()()
	withOwnHost(t, "testhost")
	dir, storage := newShuttleStore(t)
	seedShuttleRole(t, storage, "role", felt.StatusActive, oneshot(), nil)

	out, err := runCommand(t, dir, "shuttle", "reshape", "role", "standing", "--schedule", "0 9 * * 1-5")
	if err != nil {
		t.Fatalf("reshape: %v\n%s", err, out)
	}
	b, ok, err := mustRead(t, storage, "role").ShuttleBlock()
	if err != nil || !ok {
		t.Fatalf("ShuttleBlock: ok=%v err=%v", ok, err)
	}
	if b.Kind != "standing" || b.Schedule == nil {
		t.Fatalf("block: %+v", b)
	}
	if b.Schedule.Expr != "0 9 * * 1-5" || b.Schedule.TZ != "UTC" {
		t.Fatalf("schedule = %+v, want expr=0 9 * * 1-5 tz=UTC", b.Schedule)
	}
	if !strings.Contains(out, "next due:") {
		t.Fatalf("expected a next-due line:\n%s", out)
	}
}

// TestShuttleReshapeVerb_ScheduleOnlyEdit: no kind argument re-times a standing
// role in place, keeping both its kind and (with --tz omitted) its timezone.
func TestShuttleReshapeVerb_ScheduleOnlyEdit(t *testing.T) {
	defer saveShuttleGlobals()()
	withOwnHost(t, "testhost")
	dir, storage := newShuttleStore(t)
	seedShuttleRole(t, storage, "role", felt.StatusActive, standingRole(t.TempDir()), nil)

	out, err := runCommand(t, dir, "shuttle", "reshape", "role", "--schedule", "0 7 * * *")
	if err != nil {
		t.Fatalf("reshape: %v\n%s", err, out)
	}
	b, _, _ := mustRead(t, storage, "role").ShuttleBlock()
	if b.Kind != "standing" {
		t.Fatalf("kind changed on a schedule-only edit: %q", b.Kind)
	}
	if b.Schedule.Expr != "0 7 * * *" || b.Schedule.TZ != "Europe/Paris" {
		t.Fatalf("schedule = %+v, want expr=0 7 * * * tz=Europe/Paris", b.Schedule)
	}
}

// TestShuttleReshapeVerb_ScheduleRejectedForScheduleLessKinds: a schedule-less
// target must not be handed a recurrence it would silently ignore.
func TestShuttleReshapeVerb_ScheduleRejectedForScheduleLessKinds(t *testing.T) {
	for _, kind := range []string{"oneshot", "pinned"} {
		t.Run(kind, func(t *testing.T) {
			defer saveShuttleGlobals()()
			withOwnHost(t, "testhost")
			dir, storage := newShuttleStore(t)
			seedShuttleRole(t, storage, "role", felt.StatusActive, standingRole(t.TempDir()), nil)

			out, err := runCommand(t, dir, "shuttle", "reshape", "role", kind, "--schedule", "0 9 * * 1-5")
			if err == nil {
				t.Fatalf("--schedule with kind=%s must fail; out=%s", kind, out)
			}
			if !strings.Contains(err.Error(), "standing") {
				t.Fatalf("error should explain standing-only; err=%v", err)
			}
			b, _, _ := mustRead(t, storage, "role").ShuttleBlock()
			if b.Kind != "standing" {
				t.Fatalf("failed reshape mutated the block: %+v", b)
			}
		})
	}
}

// TestShuttleReshapeVerb_RequiresExistingBlock: reshape edits, it never
// creates — and says which verb does.
func TestShuttleReshapeVerb_RequiresExistingBlock(t *testing.T) {
	defer saveShuttleGlobals()()
	withOwnHost(t, "testhost")
	dir, storage := newShuttleStore(t)
	seedPlainFiber(t, storage, "note", felt.StatusOpen)

	out, err := runCommand(t, dir, "shuttle", "reshape", "note", "oneshot")
	if err == nil {
		t.Fatalf("reshape on a block-less fiber must fail; out=%s", out)
	}
	for _, verb := range []string{"install", "repeat", "pin"} {
		if !strings.Contains(err.Error(), verb) {
			t.Fatalf("error should point at %s; err=%v", verb, err)
		}
	}
}

// TestShuttleReshapeVerb_RefusesRemoteOwned mirrors
// TestShuttleRepeat_RefusesRemoteOwned: a mutator never writes a fiber another
// daemon owns.
func TestShuttleReshapeVerb_RefusesRemoteOwned(t *testing.T) {
	defer saveShuttleGlobals()()
	withOwnHost(t, "macbook")
	dir, storage := newShuttleStore(t)
	seedShuttleRole(t, storage, "remote", felt.StatusActive, map[string]any{
		"kind": "standing", "agent": "claude-opus", "host": "cineca",
		"schedule": map[string]any{"expr": "0 8 * * *", "tz": "UTC"},
	}, nil)
	before, _ := os.ReadFile(storage.Path("remote"))

	_, err := runCommand(t, dir, "shuttle", "reshape", "remote", "oneshot")
	if err == nil {
		t.Fatal("reshape on a cineca-owned role from macbook must be refused")
	}
	if _, ok := err.(ownerMismatchError); !ok {
		t.Fatalf("expected ownerMismatchError, got %T: %v", err, err)
	}
	after, _ := os.ReadFile(storage.Path("remote"))
	if string(before) != string(after) {
		t.Fatal("refused reshape must leave the mirror byte-identical")
	}
}

// TestShuttleReshapeVerb_InvalidKind: the kind enum is the verb's whole
// subject, so a bogus value fails before the write.
func TestShuttleReshapeVerb_InvalidKind(t *testing.T) {
	defer saveShuttleGlobals()()
	withOwnHost(t, "testhost")
	dir, storage := newShuttleStore(t)
	seedShuttleRole(t, storage, "role", felt.StatusActive, oneshot(), nil)

	before, _ := os.ReadFile(storage.Path("role"))

	out, err := runCommand(t, dir, "shuttle", "reshape", "role", "recurring")
	if err == nil {
		t.Fatalf("an invalid kind must fail; out=%s", out)
	}
	if !strings.Contains(err.Error(), "kind must be one of") {
		t.Fatalf("error should name the valid kinds; err=%v", err)
	}
	// The atomicity guarantee: a rejected reshape writes nothing at all.
	if after, _ := os.ReadFile(storage.Path("role")); string(before) != string(after) {
		t.Fatalf("failed reshape mutated the fiber:\n%s", after)
	}
}

// ---- create-verb boundary --------------------------------------------------

// TestShuttleCreate_FreshInstallStillRefusesClosed: the refusal survives where
// it means something — a create verb on a fiber with NO block would be ARMING
// something already closed out, which needs an explicit reopen.
func TestShuttleCreate_FreshInstallStillRefusesClosed(t *testing.T) {
	for _, args := range [][]string{
		{"install", "role"},
		{"repeat", "role", "--schedule", "0 9 * * 1-5"},
	} {
		t.Run(args[0], func(t *testing.T) {
			defer saveShuttleGlobals()()
			dir, storage := newShuttleStore(t)
			pdir := t.TempDir()
			seedPlainFiber(t, storage, "role", felt.StatusClosed)

			out, err := runCommand(t, dir, append(append([]string{"shuttle"}, args...), "--host", "testhost", "--project-dir", pdir)...)
			if err == nil {
				t.Fatalf("fresh %s on a closed fiber must refuse; out=%s", args[0], out)
			}
			if !strings.Contains(err.Error(), "reopen") {
				t.Fatalf("refusal should point at reopen; err=%v", err)
			}
		})
	}
}
