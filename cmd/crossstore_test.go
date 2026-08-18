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

// TestLsQueryWidensToEnclosingStore: search is the command whose whole job is
// finding things, so a query crosses the boundary — local hits first, the rest
// under a separator naming the store, each by its full id there. This store's
// own subtree is excluded from the outer block: it is already printed above.
func TestLsQueryWidensToEnclosingStore(t *testing.T) {
	_, subProj := newCrossStoreFixture(t)
	defer saveLsGlobals()()
	defer saveShowGlobals()()

	out, err := runCommand(t, subProj, "ls", "debug")
	if err != nil {
		t.Fatalf("ls query: %v\n%s", err, out)
	}
	root := loomRoot(t, subProj)
	if !strings.Contains(out, "── elsewhere in "+root+" ──") {
		t.Fatalf("ls output missing the enclosing-store separator:\n%s", out)
	}
	if !strings.Contains(out, "ai-futures/portolan/debug") {
		t.Fatalf("ls output missing the outer hit:\n%s", out)
	}
	if strings.Contains(out, "ai-futures/felt/debug") {
		t.Fatalf("ls output repeats a local fiber in the outer block:\n%s", out)
	}
	local := strings.Index(out, " debug\n")
	if local == -1 || local > strings.Index(out, "── elsewhere") {
		t.Fatalf("local hits should print before the outer block:\n%s", out)
	}

	// The outer id printed there is directly actionable from right here.
	showOut, err := runCommand(t, subProj, "show", "ai-futures/portolan/debug", "--detail", "name")
	if err != nil {
		t.Fatalf("show on an id from the outer block: %v\n%s", err, showOut)
	}
	if !strings.Contains(showOut, "Portolan debug") {
		t.Fatalf("show output = %q", showOut)
	}
}

// TestLsAnyFilterWidens: what makes an invocation a search is that it carries
// a filter at all — `felt ls -t bug` asks the same question as `felt ls bug`,
// and it would be incoherent for one to widen and the other not.
func TestLsAnyFilterWidens(t *testing.T) {
	for _, filter := range [][]string{
		{"-t", "decision"},
		{"-s", "all"},
		{"-s", "open"},
		{"--body", "Charted"},
	} {
		t.Run(strings.Join(filter, " "), func(t *testing.T) {
			_, subProj := newCrossStoreFixture(t)
			defer saveLsGlobals()()

			out, err := runCommand(t, subProj, append([]string{"ls"}, filter...)...)
			if err != nil {
				t.Fatalf("ls %v: %v\n%s", filter, err, out)
			}
			if !strings.Contains(out, "── elsewhere in ") {
				t.Fatalf("filter %v did not reach the enclosing store:\n%s", filter, out)
			}
		})
	}
}

// TestLsLocalKeepsASearchNarrow: --local is the escape hatch for someone who
// wants the narrow answer. There is no --all: widening is the default.
func TestLsLocalKeepsASearchNarrow(t *testing.T) {
	_, subProj := newCrossStoreFixture(t)
	defer saveLsGlobals()()

	out, err := runCommand(t, subProj, "ls", "--local", "debug")
	if err != nil {
		t.Fatalf("ls --local: %v\n%s", err, out)
	}
	if strings.Contains(out, "elsewhere in") || strings.Contains(out, "ai-futures/portolan") {
		t.Fatalf("--local still widened:\n%s", out)
	}
	if !strings.Contains(out, "debug") {
		t.Fatalf("--local lost the local hit:\n%s", out)
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
