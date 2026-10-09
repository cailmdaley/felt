package shuttlecli

import (
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

func seatOf(t *testing.T, storage *felt.Storage, id string) string {
	t.Helper()
	block, ok, err := shuttle.BlockOf(mustRead(t, storage, id))
	if err != nil || !ok {
		t.Fatalf("BlockOf %s: ok=%v err=%v", id, ok, err)
	}
	return block.Seat
}

func TestShuttleSeat_SetsTheRoleSlugAndClearsIt(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedFiber(t, storage, "roles/cmbx-chair", assignTestRoleUID, "", nil, nil)
	seedShuttleRole(t, storage, "hub", felt.StatusOpen, oneshot(), nil)

	// A role resolves by its path as well as its slug; the slug is stored.
	if out, err := runIn(t, env, dir, "seat", "hub", "roles/cmbx-chair"); err != nil {
		t.Fatalf("seat: %v\n%s", err, out)
	}
	if got := seatOf(t, storage, "hub"); got != "cmbx-chair" {
		t.Fatalf("seat = %q, want cmbx-chair", got)
	}
	f := mustRead(t, storage, "hub")
	if f.Status != felt.StatusOpen {
		t.Fatalf("seat changed lifecycle status to %q", f.Status)
	}

	if out, err := runIn(t, env, dir, "seat", "hub", "--clear"); err != nil {
		t.Fatalf("seat --clear: %v\n%s", err, out)
	}
	if got := seatOf(t, storage, "hub"); got != "" {
		t.Fatalf("seat after --clear = %q, want empty", got)
	}
}

func TestShuttleSeat_RefusesAMissingRoleOrAmbiguousArgs(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedFiber(t, storage, "roles/cmbx-chair", assignTestRoleUID, "", nil, nil)
	seedFiber(t, storage, "roles/cmbx-chair/fable", assignTestUID, "", nil, nil)
	seedShuttleRole(t, storage, "hub", felt.StatusOpen, oneshot(), nil)

	for _, argv := range [][]string{
		{"seat", "hub", "nonexistent"},            // no charter
		{"seat", "hub", "roles/cmbx-chair/fable"}, // a collaborator, not a role
		{"seat", "hub"},                           // neither a role nor --clear
		{"seat", "hub", "cmbx-chair", "--clear"},
	} {
		if _, err := runIn(t, env, dir, argv...); err == nil {
			t.Fatalf("%v: accepted", argv)
		}
	}
	if got := seatOf(t, storage, "hub"); got != "" {
		t.Fatalf("a refused seat wrote %q", got)
	}
}

func TestShuttleCheck_WarnsWhenASeatNamesNoRole(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedFiber(t, storage, "roles/vizier", assignTestRoleUID, "", nil, nil)
	good := oneshot()
	good["seat"] = "vizier"
	seedShuttleRole(t, storage, "post", felt.StatusOpen, good, nil)
	orphan := oneshot()
	orphan["seat"] = "chief-of-staff"
	seedShuttleRole(t, storage, "chair", felt.StatusOpen, orphan, nil)

	out, err := runIn(t, env, dir, "check")
	if err != nil {
		t.Fatalf("check: a missing role is a warning, not an error: %v\n%s", err, out)
	}
	if !strings.Contains(out, "chair") || !strings.Contains(out, `seat "chief-of-staff" names no role`) {
		t.Fatalf("check did not warn about the orphan seat:\n%s", out)
	}
	if strings.Contains(out, `"vizier"`) {
		t.Fatalf("check warned about a seat whose role exists:\n%s", out)
	}
}

func TestShuttleValidate_SeatMustBeARoleSlug(t *testing.T) {
	t.Parallel()
	for seat, ok := range map[string]bool{"cmbx-chair": true, "vizier": true, "roles/vizier": false, "Vizier": false, "-x": false} {
		errs := shuttle.Validate(&shuttle.Block{Kind: "oneshot", Seat: seat}, nil)
		if (len(errs) == 0) != ok {
			t.Fatalf("seat %q: valid=%v, want %v (%v)", seat, len(errs) == 0, ok, errs)
		}
	}
}
