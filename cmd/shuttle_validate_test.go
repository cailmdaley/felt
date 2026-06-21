package cmd

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

// seedShuttleFiber writes a fiber carrying a shuttle: block straight through
// storage, bypassing the cmd-layer validation — so a deliberately invalid block
// can be planted on disk to prove that the next felt edit rejects it.
func seedShuttleFiber(t *testing.T, storage *felt.Storage, id string, block map[string]any) {
	t.Helper()
	f := &felt.Felt{ID: id, Name: id, CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}
	if err := f.SetExtraField("shuttle", block); err != nil {
		t.Fatalf("SetExtraField: %v", err)
	}
	if err := storage.Write(f); err != nil {
		t.Fatalf("Write %s: %v", id, err)
	}
}

func TestEditValidatesShuttleFacet(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	seedShuttleFiber(t, storage, "good", map[string]any{"kind": "oneshot", "agent": "claude-opus"})
	seedShuttleFiber(t, storage, "bad", map[string]any{"kind": "bogus"})

	reset := saveEditGlobals()
	defer reset()

	// A fiber whose shuttle: block is valid edits normally.
	if out, err := runCommand(t, dir, "edit", "good", "--status", "active"); err != nil {
		t.Fatalf("edit good: %v\n%s", err, out)
	}

	// A fiber whose shuttle: block is invalid fails the write loudly — even
	// though this edit only touches felt-native status. felt owns the facet's
	// schema, so an invalid block can't ride through on an unrelated edit.
	out, err := runCommand(t, dir, "edit", "bad", "--status", "active")
	if err == nil {
		t.Fatalf("edit bad should fail validation, got success:\n%s", out)
	}
	if !strings.Contains(err.Error()+out, "shuttle") {
		t.Fatalf("error should mention the shuttle facet, got err=%v out=%s", err, out)
	}

	// The rejected write must not have landed: status stays unchanged on disk.
	f, err := storage.Read("bad")
	if err != nil {
		t.Fatalf("Read bad: %v", err)
	}
	if f.Status == felt.StatusActive {
		t.Fatal("invalid edit must not persist: status should not have flipped to active")
	}
}

// TestLsJSONToleratesMalformedShuttleBlock is the daemon-poll regression guard:
// the daemon lists the whole loom with `felt ls --json --has-field shuttle
// --json-field id,shuttle`. A single fiber whose shuttle: value is a bare scalar
// (not a mapping) must round-trip opaquely and NOT crash or fail the listing —
// otherwise one malformed block anywhere takes down dispatch.
func TestLsJSONToleratesMalformedShuttleBlock(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	seedShuttleFiber(t, storage, "valid", map[string]any{"kind": "oneshot", "agent": "claude-opus"})
	// A degenerate scalar shuttle: value — felt must treat it as an opaque field.
	scalar := &felt.Felt{ID: "scalar", Name: "scalar", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}
	if err := scalar.SetExtraField(felt.ShuttleFacetKey, "just-a-string"); err != nil {
		t.Fatalf("SetExtraField: %v", err)
	}
	if err := storage.Write(scalar); err != nil {
		t.Fatalf("Write scalar: %v", err)
	}

	out, err := runCommand(t, dir, "ls", "--json", "--has-field", "shuttle", "--json-field", "id,shuttle")
	if err != nil {
		t.Fatalf("ls must not fail on a malformed block: %v\n%s", err, out)
	}
	var rows []map[string]any
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		t.Fatalf("ls --json output not valid JSON: %v\n%s", err, out)
	}
	byID := map[string]map[string]any{}
	for _, r := range rows {
		byID[r["id"].(string)] = r
	}
	// The valid fiber resolves; the scalar one round-trips its raw value.
	if sh, ok := byID["valid"]["shuttle"].(map[string]any); !ok || sh["resolved"] == nil {
		t.Fatalf("valid fiber should carry a resolved shuttle, got: %v", byID["valid"]["shuttle"])
	}
	if byID["scalar"]["shuttle"] != "just-a-string" {
		t.Fatalf("scalar shuttle must round-trip opaquely, got: %v", byID["scalar"]["shuttle"])
	}
}

// TestAddPaysNoShuttleCost confirms the optional-facet invariant on the add
// seam: a plain felt add succeeds and writes no shuttle key (it can never be
// rejected by ValidateShuttleFacet, which returns before loading the registry).
func TestAddPaysNoShuttleCost(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	if out, err := runCommand(t, dir, "add", "plain", "A plain note"); err != nil {
		t.Fatalf("add: %v\n%s", err, out)
	}
	f, err := storage.Read("plain")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if f.HasShuttleFacet() {
		t.Fatal("a plain felt add must not produce a shuttle facet")
	}
}
