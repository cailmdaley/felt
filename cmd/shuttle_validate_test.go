package cmd

import (
	"encoding/json"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
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
	block, ok, err := shuttle.BlockOf(fiber)
	if err != nil || !ok || block.Kind != "bogus" {
		t.Fatalf("Shuttle facet changed: block=%+v ok=%v err=%v", block, ok, err)
	}
}

func TestFeltLsJSONPreservesShuttleWithoutResolution(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleFiber(t, storage, "valid", map[string]any{"kind": "oneshot", "agent": "claude-opus"})
	// A scalar value is opaque frontmatter, not a facet.
	scalar := &felt.Felt{ID: "scalar", Name: "scalar", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}
	if err := scalar.SetExtraField(shuttle.FacetKey, "just-a-string"); err != nil {
		t.Fatalf("SetExtraField: %v", err)
	}
	if err := storage.Write(scalar); err != nil {
		t.Fatalf("Write scalar: %v", err)
	}

	out, err := runCommand(t, dir, "ls", "--json", "--has-field", shuttle.FacetKey, "--json-field", "id,shuttle")
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
	if block, ok := byID["valid"][shuttle.FacetKey].(map[string]any); !ok || block["kind"] != "oneshot" || block["resolved"] != nil {
		t.Fatalf("felt JSON should emit the raw facet without resolution, got: %v", byID["valid"][shuttle.FacetKey])
	}
	if byID["scalar"][shuttle.FacetKey] != "just-a-string" {
		t.Fatalf("scalar frontmatter must round-trip opaquely, got: %v", byID["scalar"][shuttle.FacetKey])
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
	if shuttle.HasFacet(fiber) {
		t.Fatal("a plain felt add must not produce a shuttle facet")
	}
}
