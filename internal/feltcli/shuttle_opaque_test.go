package feltcli

import (
	"encoding/json"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func seedShuttleFiber(t *testing.T, storage *felt.Storage, id string, block map[string]any) {
	t.Helper()
	seedFiber(t, storage, id, "", "", block, nil)
}

func TestFeltEditLeavesShuttleFacetOpaque(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleFiber(t, storage, "bad", map[string]any{"kind": "bogus"})

	out, err := runCommand(t, dir, "edit", "bad", "--status", "active")
	if err != nil {
		t.Fatalf("felt edit should change status without interpreting Shuttle fields: %v\n%s", err, out)
	}
	fiber, err := storage.Read("bad")
	if err != nil {
		t.Fatalf("read edited fiber: %v", err)
	}
	if fiber.Status != felt.StatusActive {
		t.Fatalf("status = %q, want active", fiber.Status)
	}
	data, err := json.Marshal(fiber)
	if err != nil {
		t.Fatal(err)
	}
	var row map[string]any
	if err := json.Unmarshal(data, &row); err != nil {
		t.Fatal(err)
	}
	block, isMap := row["shuttle"].(map[string]any)
	if !isMap || block["kind"] != "bogus" {
		t.Fatalf("opaque Shuttle frontmatter changed: value=%#v", row["shuttle"])
	}
}

func TestFeltLsJSONPreservesShuttleWithoutResolution(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleFiber(t, storage, "valid", map[string]any{"kind": "oneshot", "agent": "claude-opus"})
	// A scalar value is opaque frontmatter, not a facet.
	scalar := &felt.Felt{ID: "scalar", Name: "scalar", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}
	if err := scalar.SetExtraField("shuttle", "just-a-string"); err != nil {
		t.Fatalf("SetExtraField: %v", err)
	}
	if err := storage.Write(scalar); err != nil {
		t.Fatalf("Write scalar: %v", err)
	}

	out, err := runCommand(t, dir, "ls", "--json", "--has-field", "shuttle", "--json-field", "id,shuttle")
	if err != nil {
		t.Fatalf("felt ls JSON: %v\n%s", err, out)
	}
	var rows []map[string]any
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		t.Fatalf("ls --json output not valid JSON: %v\n%s", err, out)
	}
	byID := map[string]map[string]any{}
	for _, row := range rows {
		byID[row["id"].(string)] = row
	}
	if block, ok := byID["valid"]["shuttle"].(map[string]any); !ok || block["kind"] != "oneshot" || block["resolved"] != nil {
		t.Fatalf("felt JSON should emit the raw field without resolution, got: %v", byID["valid"]["shuttle"])
	}
	if byID["scalar"]["shuttle"] != "just-a-string" {
		t.Fatalf("scalar frontmatter must round-trip opaquely, got: %v", byID["scalar"]["shuttle"])
	}
}

func TestFeltEditChangesStatusWithoutResolvingAgent(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleFiber(t, storage, "f", map[string]any{"kind": "oneshot", "agent": "retired-agent", "project_dir": "/srv/work"})
	if out, err := runCommand(t, dir, "edit", "f", "-s", "active"); err != nil {
		t.Fatalf("felt edit status with opaque Shuttle metadata: %v\n%s", err, out)
	}
	if got := mustRead(t, storage, "f").Status; got != felt.StatusActive {
		t.Fatalf("status = %q, want active", got)
	}
}

func TestEditOfArmedFiberWithoutProjectDirIsNotArming(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleFiber(t, storage, "role", map[string]any{
		"kind": "standing", "agent": "claude-opus",
		"schedule": map[string]any{"expr": "0 13 * * *", "tz": "Europe/Paris"},
	})
	fiber := mustRead(t, storage, "role")
	fiber.Status = felt.StatusActive
	if err := storage.Write(fiber); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"edit", "role", "-t", "morning"}, {"edit", "role", "-o", "digest sent"}, {"edit", "role", "-s", "active"}} {
		if out, err := runCommand(t, dir, args...); err != nil {
			t.Fatalf("%v on an active fiber: %v\n%s", args, err, out)
		}
	}
	fiber = mustRead(t, storage, "role")
	if fiber.Outcome != "digest sent" || fiber.Status != felt.StatusActive || len(fiber.Tags) != 1 || fiber.Tags[0] != "morning" {
		t.Fatalf("after edits: status=%q outcome=%q tags=%v", fiber.Status, fiber.Outcome, fiber.Tags)
	}
}

func TestAddPaysNoShuttleCost(t *testing.T) {
	dir, storage := newStore(t)
	if out, err := runCommand(t, dir, "add", "plain", "A plain note"); err != nil {
		t.Fatalf("add: %v\n%s", err, out)
	}
	fiber, err := storage.Read("plain")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if _, present := fiber.ExtraFields["shuttle"]; present {
		t.Fatal("a plain felt add must not produce Shuttle frontmatter")
	}
}
