package shuttlecli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

func newCrossStoreFixture(t *testing.T) (loomProj, subProj string) {
	t.Helper()
	tmp := t.TempDir()
	loomProj = filepath.Join(tmp, "loom")
	loom := felt.NewStorage(loomProj)
	if err := loom.Init(); err != nil {
		t.Fatalf("loom init: %v", err)
	}
	if err := loom.Write(&felt.Felt{ID: "commons", Name: "Commons"}); err != nil {
		t.Fatalf("write outer fiber: %v", err)
	}
	content := filepath.Join(loomProj, ".felt", "ai-futures", "felt")
	if err := os.MkdirAll(content, 0o755); err != nil {
		t.Fatalf("mkdir substore content: %v", err)
	}
	subProj = filepath.Join(tmp, "project")
	if err := os.MkdirAll(subProj, 0o755); err != nil {
		t.Fatalf("mkdir project: %v", err)
	}
	if err := os.Symlink(content, filepath.Join(subProj, ".felt")); err != nil {
		t.Fatalf("symlink substore: %v", err)
	}
	local := felt.NewStorage(subProj)
	if err := local.Write(&felt.Felt{ID: "debug", Name: "Local debug", Status: felt.StatusOpen}); err != nil {
		t.Fatalf("write local fiber: %v", err)
	}
	return loomProj, subProj
}

func TestShuttleVerbsCrossTheBoundary(t *testing.T) {
	loomProj, subProj := newCrossStoreFixture(t)
	loom := felt.NewStorage(loomProj)
	seedShuttleRole(t, loom, "ai-futures/portolan/debug", felt.StatusActive, oneshot(), nil)
	withStubbedTmux(t, map[string]bool{})

	out, err := runCommand(t, subProj, "pause", "ai-futures/portolan/debug")
	if err != nil {
		t.Fatalf("shuttle pause across the boundary: %v\n%s", err, out)
	}
	if !strings.Contains(out, filepath.Join(loomProj, ".felt")) {
		t.Fatalf("shuttle pause output = %q, want the enclosing store named", out)
	}
	if got := mustRead(t, loom, "ai-futures/portolan/debug").Status; got != felt.StatusOpen {
		t.Fatalf("outer fiber status = %q, want open", got)
	}
	local := felt.NewStorage(subProj)
	if got := mustRead(t, local, "debug").Status; got != felt.StatusOpen {
		t.Fatalf("local twin status = %q, want open", got)
	}
	if shuttle.HasFacet(mustRead(t, local, "debug")) {
		t.Fatal("the local same-slug fiber was acted on")
	}
}
