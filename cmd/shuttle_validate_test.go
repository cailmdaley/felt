package cmd

import (
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
