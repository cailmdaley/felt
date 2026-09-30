package feltcli

import (
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func readFiberBody(t *testing.T, s *felt.Storage, id string) string {
	t.Helper()
	f, err := s.Read(id)
	if err != nil {
		t.Fatalf("read %s: %v", id, err)
	}
	return f.Body
}

func TestNestNamesRewrittenFibersAndCheckStaysClean(t *testing.T) {
	dir, storage := newStore(t)
	for _, f := range []*felt.Felt{
		{ID: "a", Name: "A"},
		{ID: "b", Name: "B"},
		{ID: "a/x", Name: "X"},
		{ID: "c", Name: "C", Body: "See [[b]] and [[a/x]]."},
	} {
		if err := storage.Write(f); err != nil {
			t.Fatalf("write %s: %v", f.ID, err)
		}
	}

	out, err := runCommand(t, dir, "nest", "x", "b")
	if err != nil {
		t.Fatalf("nest: %v\n%s", err, out)
	}
	if want := "Nested a/x under b as b/x\nRewrote references in c\n"; out != want {
		t.Fatalf("nest output = %q, want %q", out, want)
	}
	if got := readFiberBody(t, storage, "c"); got != "See [[b]] and [[b/x]]." {
		t.Fatalf("c body = %q", got)
	}

	out, err = runCommand(t, dir, "unnest", "b/x")
	if err != nil {
		t.Fatalf("unnest: %v\n%s", err, out)
	}
	if want := "Promoted b/x to x\nRewrote references in c\n"; out != want {
		t.Fatalf("unnest output = %q, want %q", out, want)
	}
	if got := readFiberBody(t, storage, "c"); got != "See [[b]] and [[x]]." {
		t.Fatalf("c body = %q", got)
	}

	if out, err := runCommand(t, dir, "check"); err != nil || strings.Contains(out, "WARNING") {
		t.Fatalf("check after nest/unnest: %v\n%s", err, out)
	}
}

// In a view, links to a local fiber are written either with the view's own
// ids or with the enclosing store's; a move inside the view rewrites both.
func TestNestInViewRewritesBothSpellings(t *testing.T) {
	_, subProj := newCrossStoreFixture(t)
	sub := felt.NewStorage(subProj)
	body := "Local [[notes/runbook]], outer [[ai-futures/felt/notes/runbook]]."
	if err := sub.Write(&felt.Felt{ID: "notes", Name: "Notes"}); err != nil {
		t.Fatal(err)
	}
	if err := sub.Write(&felt.Felt{ID: "citer", Name: "Citer", Body: body}); err != nil {
		t.Fatal(err)
	}

	if out, err := runCommand(t, subProj, "nest", "notes/runbook", "debug"); err != nil {
		t.Fatalf("nest: %v\n%s", err, out)
	}
	want := "Local [[debug/runbook]], outer [[ai-futures/felt/debug/runbook]]."
	if got := readFiberBody(t, sub, "citer"); got != want {
		t.Fatalf("citer body = %q, want %q", got, want)
	}
}

// A move lifted into the enclosing store sees every fiber there, the view's
// included, and rewrites their links in the spelling each was written in.
func TestNestAcrossBoundaryRewritesViewLinks(t *testing.T) {
	_, subProj := newCrossStoreFixture(t)
	sub := felt.NewStorage(subProj)
	if err := sub.Write(&felt.Felt{ID: "citer", Name: "Citer", Body: "See [[ai-futures/portolan/debug]]."}); err != nil {
		t.Fatal(err)
	}

	if out, err := runCommand(t, subProj, "nest", "ai-futures/portolan/debug", "notes/runbook"); err != nil {
		t.Fatalf("nest: %v\n%s", err, out)
	}
	want := "See [[ai-futures/felt/notes/runbook/debug]]."
	if got := readFiberBody(t, sub, "citer"); got != want {
		t.Fatalf("citer body = %q, want %q", got, want)
	}
}

// A move inside a view also rewrites the enclosing store's fibers outside it,
// in that store's coordinates, keeping each link's shape; nest names them by
// their ids there.
func TestNestInViewRewritesEnclosingStore(t *testing.T) {
	loomProj, subProj := newCrossStoreFixture(t)
	loom := felt.NewStorage(loomProj)
	body := "Full [[ai-futures/felt/notes/runbook]], suffix [[felt/notes/runbook]], bare [[runbook]]."
	if err := loom.Write(&felt.Felt{ID: "commons/citer", Name: "Citer", Body: body}); err != nil {
		t.Fatal(err)
	}

	out, err := runCommand(t, subProj, "nest", "notes/runbook", "debug")
	if err != nil {
		t.Fatalf("nest: %v\n%s", err, out)
	}
	if want := "Rewrote references in commons/citer (in " + loomRoot(t, subProj) + ")\n"; !strings.HasSuffix(out, want) {
		t.Fatalf("nest output = %q, want it to end %q", out, want)
	}
	want := "Full [[ai-futures/felt/debug/runbook]], suffix [[felt/debug/runbook]], bare [[runbook]]."
	if got := readFiberBody(t, loom, "commons/citer"); got != want {
		t.Fatalf("outer citer body = %q, want %q", got, want)
	}
}
