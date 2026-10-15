package shuttlecli

import (
	"os"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

const roleTestUID = "01BX5ZZKBKACTAV9WEVGEMMVRZ"

func officeOf(t *testing.T, storage *felt.Storage, id string) *shuttle.Block {
	t.Helper()
	block, ok, err := shuttle.BlockOf(mustRead(t, storage, id))
	if err != nil || !ok {
		t.Fatalf("BlockOf %s: ok=%v err=%v", id, ok, err)
	}
	return block
}

func TestShuttleRoleAndSeat(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedFiber(t, storage, "roles/cmbx-chair", roleTestUID, "", nil, nil)
	seedFiber(t, storage, "roles/vizier", "01ARZ3NDEKTSV4RRFFQ69G5FAV", "", nil, nil)
	seedShuttleRole(t, storage, "hub", felt.StatusOpen, oneshot(), nil)
	for _, step := range []struct {
		args []string
		role string
		seat bool
	}{
		{[]string{"role", "hub", "cmbx-chair"}, "cmbx-chair", false},
		{[]string{"seat", "hub"}, "cmbx-chair", true},
		{[]string{"role", "hub", "vizier"}, "vizier", true},
		{[]string{"seat", "hub", "--clear"}, "vizier", false},
		{[]string{"seat", "hub"}, "vizier", true},
		{[]string{"role", "hub", "--clear"}, "", false},
	} {
		if out, err := runIn(t, env, dir, step.args...); err != nil {
			t.Fatalf("%v: %v\n%s", step.args, err, out)
		}
		block := officeOf(t, storage, "hub")
		if block.Role != step.role || block.Seat != step.seat {
			t.Fatalf("%v: role=%q seat=%v", step.args, block.Role, block.Seat)
		}
		if f := mustRead(t, storage, "hub"); f.Status != felt.StatusOpen {
			t.Fatalf("changed lifecycle status to %q", f.Status)
		}
	}
	f := mustRead(t, storage, "hub")
	if felt.MappingValueNode(f.ExtraFields["shuttle"], "role") != nil || felt.MappingValueNode(f.ExtraFields["shuttle"], "seat") != nil {
		t.Fatal("role --clear retained office fields")
	}
}

func TestShuttleOffice_RefusesInvalidArgumentsWithoutWriting(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "hub", felt.StatusOpen, oneshot(), nil)
	before, err := os.ReadFile(storage.Path("hub"))
	if err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{"role", "hub", "nonexistent"}, {"role", "hub", "roles/vizier"},
		{"role", "hub", "Vizier"}, {"role", "hub", "bad--slug"},
		{"role", "hub"}, {"role", "hub", "vizier", "--clear"},
		{"seat", "hub"}, {"seat", "hub", "vizier"}, {"assign", "hub"},
	} {
		if _, err := runIn(t, env, dir, args...); err == nil {
			t.Fatalf("%v: accepted", args)
		}
	}
	after, err := os.ReadFile(storage.Path("hub"))
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("refused office commands changed the file")
	}
}

func TestShuttleCheck_WarnsWhenRoleHasNoCharter(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedFiber(t, storage, "roles/vizier", roleTestUID, "", nil, nil)
	for id, role := range map[string]string{"post": "vizier", "chair": "chief-of-staff"} {
		block := oneshot()
		block["role"] = role
		seedShuttleRole(t, storage, id, felt.StatusOpen, block, nil)
	}
	out, err := runIn(t, env, dir, "check")
	if err != nil {
		t.Fatalf("missing charter should be a warning: %v\n%s", err, out)
	}
	if !strings.Contains(out, `role "chief-of-staff" has no charter`) || strings.Contains(out, `"vizier"`) {
		t.Fatalf("unexpected warnings:\n%s", out)
	}
}

func TestShuttleCheck_DiagnosesUnmigratedOfficeFields(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedFiber(t, storage, "plain", "01ARZ3NDEKTSV4RRFFQ69G5FAV", "", nil, nil)
	f := mustRead(t, storage, "plain")
	if err := f.SetExtraField("collaboration", map[string]any{"vizier": []string{}}); err != nil {
		t.Fatal(err)
	}
	if err := storage.Write(f); err != nil {
		t.Fatal(err)
	}
	block := oneshot()
	block["seat"] = "vizier"
	seedShuttleRole(t, storage, "hub", felt.StatusOpen, block, nil)
	out, err := runIn(t, env, dir, "check")
	if err == nil || !strings.Contains(out, "replace collaboration with one shuttle.role") || !strings.Contains(out, "shuttle.seat: true") {
		t.Fatalf("missing migration diagnoses: %v\n%s", err, out)
	}
}

func TestShuttleValidate_Office(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		role        string
		seat, valid bool
	}{
		{"", false, true}, {"vizier", false, true}, {"cmbx-chair", true, true},
		{"", true, false}, {"roles/vizier", false, false}, {"Vizier", false, false},
		{"-x", false, false}, {"x-", false, false}, {"x--y", false, false},
	} {
		errs := shuttle.Validate(&shuttle.Block{Kind: "oneshot", Role: tc.role, Seat: tc.seat}, nil)
		if (len(errs) == 0) != tc.valid {
			t.Fatalf("%+v: %v", tc, errs)
		}
	}
}

func TestShuttleOffice_SurvivesConfigAndLifecycleWrites(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	block := oneshot()
	block["role"] = "vizier"
	block["seat"] = true
	seedShuttleRole(t, storage, "hub", felt.StatusOpen, block, nil)
	for _, args := range [][]string{
		{"set-agent", "hub", "claude-sonnet"}, {"set-model", "hub", "claude-opus"},
		{"reshape", "hub", "standing", "--schedule", "0 8 * * *", "--tz", "UTC"},
		{"reshape", "hub", "oneshot"}, {"rest", "hub"},
	} {
		if out, err := runIn(t, env, dir, args...); err != nil {
			t.Fatalf("%v: %v\n%s", args, err, out)
		}
		b := officeOf(t, storage, "hub")
		if b.Role != "vizier" || !b.Seat {
			t.Fatalf("%v lost office: %+v", args, b)
		}
		node := mustRead(t, storage, "hub").ExtraFields["shuttle"]
		for _, key := range []string{"role", "seat"} {
			count := 0
			for i := 0; i < len(node.Content); i += 2 {
				if node.Content[i].Value == key {
					count++
				}
			}
			if count != 1 {
				t.Fatalf("%v: %s appears %d times", args, key, count)
			}
		}
	}
}
