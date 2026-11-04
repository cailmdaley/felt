package feltcli

import (
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestMoveCommandRetriesAfterRename(t *testing.T) {
	for _, verb := range []string{"nest", "unnest"} {
		for _, spelling := range []string{"old", "new"} {
			t.Run(verb+"/"+spelling, func(t *testing.T) {
				dir, storage := newStore(t)
				for _, id := range []string{"a", "a/x", "b", "ref"} {
					f := &felt.Felt{ID: id, Name: id}
					if id == "ref" {
						f.Body = "See [[a/x]]."
					}
					if err := storage.Write(f); err != nil {
						t.Fatal(err)
					}
				}
				args := []string{verb, "a/x"}
				target := "x"
				if verb == "nest" {
					args = append(args, "b")
					target = "b/x"
				}
				unlock, err := storage.LockFiber("ref")
				if err != nil {
					t.Fatal(err)
				}
				defer unlock()
				if _, err := runCommand(t, dir, args...); err == nil {
					t.Fatal("expected interrupted move")
				}
				if err := unlock(); err != nil {
					t.Fatal(err)
				}
				if spelling == "new" {
					args[1] = target
				}
				if out, err := runCommand(t, dir, args...); err != nil {
					t.Fatalf("retry: %v\n%s", err, out)
				}
				if got := mustRead(t, storage, "ref").Body; got != "See [["+target+"]]." {
					t.Fatal(got)
				}
			})
		}
	}
}

func TestAbandonPendingMovePreservesDocuments(t *testing.T) {
	dir, storage := newStore(t)
	for _, id := range []string{"a", "a/x", "b", "ref"} {
		f := &felt.Felt{ID: id, Name: id, Body: "See [[a/x]]."}
		if err := storage.Write(f); err != nil {
			t.Fatal(err)
		}
	}
	unlock, err := storage.LockFiber("ref")
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	if _, err := runCommand(t, dir, "nest", "a/x", "b"); err == nil {
		t.Fatal("expected interruption")
	}
	if err := unlock(); err != nil {
		t.Fatal(err)
	}
	before := mustRead(t, storage, "ref").Body
	if _, err := runCommand(t, dir, "recover-move", "--abandon"); err != nil {
		t.Fatal(err)
	}
	if got := mustRead(t, storage, "ref").Body; got != before {
		t.Fatalf("abandon edited document: %s", got)
	}
	if _, err := runCommand(t, dir, "unnest", "b/x"); err != nil {
		t.Fatal(err)
	}
}

func TestNestNamesRewrittenFibersAndCheckStaysClean(t *testing.T) {
	t.Parallel()
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
	if got := mustRead(t, storage, "c").Body; got != "See [[b]] and [[b/x]]." {
		t.Fatalf("c body = %q", got)
	}

	out, err = runCommand(t, dir, "unnest", "b/x")
	if err != nil {
		t.Fatalf("unnest: %v\n%s", err, out)
	}
	if want := "Promoted b/x to x\nRewrote references in c\n"; out != want {
		t.Fatalf("unnest output = %q, want %q", out, want)
	}
	if got := mustRead(t, storage, "c").Body; got != "See [[b]] and [[x]]." {
		t.Fatalf("c body = %q", got)
	}

	if out, err := runCommand(t, dir, "check"); err != nil || strings.Contains(out, "WARNING") {
		t.Fatalf("check after nest/unnest: %v\n%s", err, out)
	}
}

// In a view, links to a local fiber are written either with the view's own
// ids or with the enclosing store's; a move inside the view rewrites both.
func TestNestInViewRewritesBothSpellings(t *testing.T) {
	t.Parallel()
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
	if got := mustRead(t, sub, "citer").Body; got != want {
		t.Fatalf("citer body = %q, want %q", got, want)
	}
}

// A move lifted into the enclosing store sees every fiber there, the view's
// included, and rewrites their links in the spelling each was written in.
func TestNestAcrossBoundaryRewritesViewLinks(t *testing.T) {
	t.Parallel()
	_, subProj := newCrossStoreFixture(t)
	sub := felt.NewStorage(subProj)
	if err := sub.Write(&felt.Felt{ID: "citer", Name: "Citer", Body: "See [[ai-futures/portolan/debug]]."}); err != nil {
		t.Fatal(err)
	}

	if out, err := runCommand(t, subProj, "nest", "ai-futures/portolan/debug", "notes/runbook"); err != nil {
		t.Fatalf("nest: %v\n%s", err, out)
	}
	want := "See [[ai-futures/felt/notes/runbook/debug]]."
	if got := mustRead(t, sub, "citer").Body; got != want {
		t.Fatalf("citer body = %q, want %q", got, want)
	}
}

// A move inside a view also rewrites the enclosing store's fibers outside it,
// in that store's coordinates, keeping each link's shape; nest names them by
// their ids there.
func TestNestInViewRewritesEnclosingStore(t *testing.T) {
	t.Parallel()
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
	if got := mustRead(t, loom, "commons/citer").Body; got != want {
		t.Fatalf("outer citer body = %q, want %q", got, want)
	}
}
