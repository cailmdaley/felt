package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
)

// newCrossStoreFixture builds the loom shape: an enclosing store, a project
// whose `.felt` is a symlink into a subdirectory of it, and fibers on both
// sides — including a same-slug pair (`debug` here, `ai-futures/portolan/debug`
// out there) so every test exercises the case that used to misresolve.
func newCrossStoreFixture(t *testing.T) (loomProj, subProj string) {
	t.Helper()
	tmp := t.TempDir()

	loomProj = filepath.Join(tmp, "loom")
	loom := felt.NewStorage(loomProj)
	if err := loom.Init(); err != nil {
		t.Fatalf("loom init: %v", err)
	}
	writeFixtureFelt(t, loom, "ai-futures/portolan/debug", "Portolan debug")
	tagged := &felt.Felt{ID: "ai-futures/portolan/charted", Name: "Charted", Tags: []string{"decision"}, Status: felt.StatusOpen, CreatedAt: time.Now()}
	if err := loom.Write(tagged); err != nil {
		t.Fatalf("write tagged fiber: %v", err)
	}
	writeFixtureFelt(t, loom, "commons", "Commons")

	content := filepath.Join(loomProj, ".felt", "ai-futures", "felt")
	if err := os.MkdirAll(content, 0755); err != nil {
		t.Fatalf("mkdir substore content: %v", err)
	}
	subProj = filepath.Join(tmp, "project")
	if err := os.MkdirAll(subProj, 0755); err != nil {
		t.Fatalf("mkdir project: %v", err)
	}
	if err := os.Symlink(content, filepath.Join(subProj, ".felt")); err != nil {
		t.Fatalf("symlink substore: %v", err)
	}
	sub := felt.NewStorage(subProj)
	writeFixtureFelt(t, sub, "debug", "Local debug")
	writeFixtureFelt(t, sub, "notes/runbook", "Runbook")
	return loomProj, subProj
}

func writeFixtureFelt(t *testing.T, s *felt.Storage, id, name string) {
	t.Helper()
	if err := s.Write(&felt.Felt{ID: id, Name: name, Status: felt.StatusOpen, CreatedAt: time.Now()}); err != nil {
		t.Fatalf("write %s: %v", id, err)
	}
}

func loomRoot(t *testing.T, subProj string) string {
	t.Helper()
	root, _, ok := felt.NewStorage(subProj).EnclosingStore()
	if !ok {
		t.Fatalf("fixture project is not a substore")
	}
	return root
}

// TestShowReachesEnclosingStore: a substore is a lens, not a fence — an id
// that names one real fiber out there is shown, not refused.
func TestShowReachesEnclosingStore(t *testing.T) {
	_, subProj := newCrossStoreFixture(t)
	defer saveShowGlobals()()

	out, err := runCommand(t, subProj, "show", "ai-futures/portolan/debug", "--detail", "name")
	if err != nil {
		t.Fatalf("show across the boundary: %v\n%s", err, out)
	}
	if !strings.Contains(out, "Portolan debug") {
		t.Fatalf("show output = %q, want the fiber from the enclosing store", out)
	}
}

// TestRmReachesEnclosingStoreAndSaysWhere: the destructive verb acts on the
// fiber the user named, where it lives, and never on the local same-slug one.
func TestRmReachesEnclosingStoreAndSaysWhere(t *testing.T) {
	loomProj, subProj := newCrossStoreFixture(t)

	out, err := runCommand(t, subProj, "rm", "ai-futures/portolan/debug")
	if err != nil {
		t.Fatalf("rm across the boundary: %v\n%s", err, out)
	}
	if !strings.Contains(out, "Deleted ai-futures/portolan/debug") {
		t.Fatalf("rm output = %q, want the outer id", out)
	}
	if !strings.Contains(out, "(in "+loomRoot(t, subProj)+")") {
		t.Fatalf("rm output = %q, want the enclosing store named", out)
	}
	if _, err := felt.NewStorage(loomProj).Read("ai-futures/portolan/debug"); err == nil {
		t.Fatalf("outer fiber survived a cross-store rm")
	}
	if _, err := felt.NewStorage(subProj).Read("debug"); err != nil {
		t.Fatalf("local same-slug fiber was destroyed: %v", err)
	}
	_ = loomProj
}

// TestEditReachesEnclosingStoreAndSaysWhere: edit is a mutation too, so it
// names where it wrote.
func TestEditReachesEnclosingStoreAndSaysWhere(t *testing.T) {
	loomProj, subProj := newCrossStoreFixture(t)
	defer saveEditGlobals()()

	out, err := runCommand(t, subProj, "edit", "ai-futures/portolan/debug", "--name", "Renamed out there")
	if err != nil {
		t.Fatalf("edit across the boundary: %v\n%s", err, out)
	}
	if !strings.Contains(out, "Updated ai-futures/portolan/debug (in "+loomRoot(t, subProj)+")") {
		t.Fatalf("edit output = %q, want the outer id and store", out)
	}
	f, err := felt.NewStorage(loomProj).Read("ai-futures/portolan/debug")
	if err != nil {
		t.Fatalf("read outer fiber: %v", err)
	}
	if f.Name != "Renamed out there" {
		t.Fatalf("outer fiber name = %q, want the edit to have landed", f.Name)
	}
	if local, err := felt.NewStorage(subProj).Read("debug"); err != nil || local.Name != "Local debug" {
		t.Fatalf("local same-slug fiber was edited instead: %v %+v", err, local)
	}
}

// TestNestAcrossBoundaryLiftsBothIDs: one loom, one namespace — nesting an
// external fiber under a local parent runs in the enclosing store with the
// local id translated into outer coordinates.
func TestNestAcrossBoundaryLiftsBothIDs(t *testing.T) {
	loomProj, subProj := newCrossStoreFixture(t)

	out, err := runCommand(t, subProj, "nest", "ai-futures/portolan/debug", "notes/runbook")
	if err != nil {
		t.Fatalf("nest across the boundary: %v\n%s", err, out)
	}
	if !strings.Contains(out, "ai-futures/felt/notes/runbook/debug") {
		t.Fatalf("nest output = %q, want the target in outer coordinates", out)
	}
	if !strings.Contains(out, "(in "+loomRoot(t, subProj)+")") {
		t.Fatalf("nest output = %q, want the enclosing store named", out)
	}
	if _, err := felt.NewStorage(loomProj).Read("ai-futures/felt/notes/runbook/debug"); err != nil {
		t.Fatalf("fiber not at its new outer id: %v", err)
	}
	// And the moved fiber is now visible from inside the project, at the id
	// the local view spells it with.
	if _, err := felt.NewStorage(subProj).Read("notes/runbook/debug"); err != nil {
		t.Fatalf("moved fiber not visible locally: %v", err)
	}
}

// TestUnnestAcrossBoundaryPromotesInEnclosingStore: top level means the top
// level of the store that holds the fiber.
func TestUnnestAcrossBoundaryPromotesInEnclosingStore(t *testing.T) {
	loomProj, subProj := newCrossStoreFixture(t)

	out, err := runCommand(t, subProj, "unnest", "ai-futures/portolan/debug")
	if err != nil {
		t.Fatalf("unnest across the boundary: %v\n%s", err, out)
	}
	if !strings.Contains(out, "Promoted ai-futures/portolan/debug to debug") {
		t.Fatalf("unnest output = %q", out)
	}
	if !strings.Contains(out, "(in "+loomRoot(t, subProj)+")") {
		t.Fatalf("unnest output = %q, want the enclosing store named", out)
	}
	if _, err := felt.NewStorage(loomProj).Read("debug"); err != nil {
		t.Fatalf("fiber not promoted in the enclosing store: %v", err)
	}
}

// TestLsStaysInTheView: ls lists the view. A query narrows that listing; it
// does not become a search of the store — that is what `felt find` is for, and
// a filtered ls in a substore says so on a trailer line.
func TestLsStaysInTheView(t *testing.T) {
	_, subProj := newCrossStoreFixture(t)
	defer saveLsGlobals()()

	out, err := runCommand(t, subProj, "ls", "debug")
	if err != nil {
		t.Fatalf("ls query: %v\n%s", err, out)
	}
	if strings.Contains(out, "elsewhere in") || strings.Contains(out, "ai-futures/portolan") {
		t.Fatalf("ls reached the enclosing store:\n%s", out)
	}
	if !strings.Contains(out, "debug") {
		t.Fatalf("ls lost the local hit:\n%s", out)
	}
	if !strings.Contains(out, "`felt find` searches the whole store at "+loomRoot(t, subProj)) {
		t.Fatalf("filtered ls in a substore should point at find:\n%s", out)
	}
}

// TestLsFilterTrailerIsTextOnly: --json is the wire the daemon and the board
// read; a human-facing hint has no place in it.
func TestLsFilterTrailerIsTextOnly(t *testing.T) {
	_, subProj := newCrossStoreFixture(t)
	defer saveLsGlobals()()

	out, err := runCommand(t, subProj, "ls", "debug", "--json")
	if err != nil {
		t.Fatalf("ls --json: %v\n%s", err, out)
	}
	if strings.Contains(out, "view-local") {
		t.Fatalf("--json carried the trailer:\n%s", out)
	}
}

// TestLsBareStaysLocal: a bare listing answers "what am I working on here",
// and must not pay for — or print — the enclosing store.
func TestLsBareStaysLocal(t *testing.T) {
	_, subProj := newCrossStoreFixture(t)
	defer saveLsGlobals()()

	out, err := runCommand(t, subProj, "ls")
	if err != nil {
		t.Fatalf("bare ls: %v\n%s", err, out)
	}
	if strings.Contains(out, "elsewhere in") {
		t.Fatalf("bare ls widened to the enclosing store:\n%s", out)
	}
	if strings.Contains(out, "ai-futures/portolan") || strings.Contains(out, "commons") {
		t.Fatalf("bare ls printed fibers from the enclosing store:\n%s", out)
	}
	if !strings.Contains(out, "debug") {
		t.Fatalf("bare ls lost the local fibers:\n%s", out)
	}
}

// TestPartialForeignPathResolvesRegardless: the enclosing-store probe used to
// be gated on the local basename rescue being about to fire, so whether
// `felt show portolan/debug` resolved depended on an accident of local naming —
// a local `debug` made it work, two of them made it fail. The gate is gone;
// resolution reaches the enclosing store on every local miss.
func TestPartialForeignPathResolvesRegardless(t *testing.T) {
	loomProj, subProj := newCrossStoreFixture(t)
	defer saveShowGlobals()()

	// A second local `debug` twin: under the old gate this ambiguity switched
	// the probe off and the foreign path stopped resolving.
	writeFixtureFelt(t, felt.NewStorage(subProj), "notes/debug", "Another local debug")

	out, err := runCommand(t, subProj, "show", "portolan/debug", "--detail", "name")
	if err != nil {
		t.Fatalf("partial foreign path did not resolve: %v\n%s", err, out)
	}
	if !strings.Contains(out, "Portolan debug") {
		t.Fatalf("show output = %q, want the fiber from the enclosing store", out)
	}
	if _, err := felt.NewStorage(loomProj).Read("ai-futures/portolan/debug"); err != nil {
		t.Fatalf("fixture fiber missing: %v", err)
	}
}

// TestShuttleVerbsCrossTheBoundary: a shuttle verb acts on the fiber the user
// named, where it lives, and says where — the same contract rm and edit keep.
func TestShuttleVerbsCrossTheBoundary(t *testing.T) {
	loomProj, subProj := newCrossStoreFixture(t)
	defer saveShuttleGlobals()()

	loom := felt.NewStorage(loomProj)
	seedShuttleRole(t, loom, "ai-futures/portolan/debug", felt.StatusActive, oneshot(), nil)
	withStubbedTmux(t, map[string]bool{})

	out, err := runCommand(t, subProj, "shuttle", "pause", "ai-futures/portolan/debug")
	if err != nil {
		t.Fatalf("shuttle pause across the boundary: %v\n%s", err, out)
	}
	if !strings.Contains(out, "(in "+loomRoot(t, subProj)+")") {
		t.Fatalf("shuttle pause output = %q, want the enclosing store named", out)
	}
	if got := mustRead(t, loom, "ai-futures/portolan/debug").Status; got != felt.StatusOpen {
		t.Fatalf("outer fiber status = %q, want open", got)
	}
	if got := mustRead(t, felt.NewStorage(subProj), "debug").Status; got != felt.StatusOpen {
		// The local same-slug fiber is seeded open; assert it was untouched by
		// checking it still carries no shuttle block.
		t.Fatalf("local twin status = %q", got)
	}
	if mustRead(t, felt.NewStorage(subProj), "debug").HasShuttleFacet() {
		t.Fatalf("the local same-slug fiber was acted on")
	}
}
