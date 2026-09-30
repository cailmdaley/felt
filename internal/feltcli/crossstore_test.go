package feltcli

import (
	"errors"
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

	out, err := runCommand(t, subProj, "show", "ai-futures/portolan/debug", "--detail", "name")
	if err != nil {
		t.Fatalf("show across the boundary: %v\n%s", err, out)
	}
	if !strings.Contains(out, "Portolan debug") {
		t.Fatalf("show output = %q, want the fiber from the enclosing store", out)
	}
}

func TestShowResolvesIntrinsicUIDFromEnclosingStore(t *testing.T) {
	loomProj, subProj := newCrossStoreFixture(t)
	uid := "01ARZ3NDEKTSV4RRFFQ69G5FAV"
	seedFiber(t, felt.NewStorage(loomProj), "roles/vizier", uid, "", nil, nil)

	out, err := runCommand(t, subProj, "show", uid, "--detail", "name")
	if err != nil {
		t.Fatalf("show enclosing UID: %v\n%s", err, out)
	}
	if !strings.Contains(out, "roles/vizier") {
		t.Fatalf("show output = %q, want enclosing profile", out)
	}
}

func TestShowRejectsDuplicateIntrinsicUIDAcrossEnclosingStore(t *testing.T) {
	loomProj, subProj := newCrossStoreFixture(t)
	uid := "01ARZ3NDEKTSV4RRFFQ69G5FAV"
	seedFiber(t, felt.NewStorage(loomProj), "roles/vizier", uid, "", nil, nil)
	seedFiber(t, felt.NewStorage(subProj), "local-copy", uid, "", nil, nil)

	out, err := runCommand(t, subProj, "show", uid, "--detail", "name")
	if err == nil || !strings.Contains(err.Error(), "ambiguous fiber UID") {
		t.Fatalf("duplicate UID error = %v\n%s", err, out)
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

// TestRmAndMovesActOnlyOnExactIDs: deleting and moving never act on a guess.
// A path that names nothing here — a stale path, a companion file's name —
// but whose slug a forgiving rule would answer is refused with the answer as
// a suggestion; the same-named fiber survives. `show` stays forgiving.
func TestRmAndMovesActOnlyOnExactIDs(t *testing.T) {
	dir, storage := newStore(t)
	for _, id := range []string{"a", "b", "b/zzz", "b/notes"} {
		writeFixtureFelt(t, storage, id, id)
	}
	if err := os.WriteFile(filepath.Join(dir, ".felt", "a", "notes.md"), []byte("plain notes\n"), 0644); err != nil {
		t.Fatalf("write companion: %v", err)
	}

	for _, args := range [][]string{
		{"rm", "a/zzz"},
		{"rm", "a/notes"},
		{"nest", "a/zzz", "a"},
		{"nest", "a", "c/zzz"},
		{"unnest", "a/zzz"},
	} {
		out, err := runCommand(t, dir, args...)
		if err == nil {
			t.Errorf("felt %v acted on a guess:\n%s", args, out)
			continue
		}
		var guess *felt.GuessError
		if !errors.As(err, &guess) || !strings.Contains(err.Error(), "did you mean b/") {
			t.Errorf("felt %v error = %v, want a did-you-mean refusal", args, err)
		}
	}
	for _, id := range []string{"b/zzz", "b/notes"} {
		if _, err := storage.Read(id); err != nil {
			t.Fatalf("%s was touched: %v", id, err)
		}
	}

	// What check accepts silently is not a guess: the lexical scope (from
	// inside b, `zzz` is b/zzz), a unique bare slug, a correct partial tail.
	// A prefix completion is.
	writeFixtureFelt(t, storage, "b/zzz/deep", "Deep")
	for _, tc := range []struct{ scope, query, want string }{
		{"b", "zzz", "b/zzz"},
		{"", "deep", "b/zzz/deep"},
		{"", "zzz/deep", "b/zzz/deep"},
	} {
		if f, err := storage.FindMetadataWithoutGuessing(tc.scope, tc.query); err != nil || f.ID != tc.want {
			t.Errorf("FindMetadataWithoutGuessing(%q, %q) = %v, %v; want %s", tc.scope, tc.query, f, err, tc.want)
		}
	}
	var prefix *felt.GuessError
	if _, err := storage.FindMetadataWithoutGuessing("b", "zz"); !errors.As(err, &prefix) || prefix.Guess != "b/zzz" {
		t.Errorf("prefix completion = %v, want a guess naming b/zzz", err)
	}
	out, err := runCommand(t, dir, "show", "a/zzz", "--detail", "name")
	if err != nil || !strings.Contains(out, "b/zzz") {
		t.Fatalf("show should stay forgiving: %v\n%s", err, out)
	}
}

// TestRmThroughViewRefusesEnclosingStoreGuesses: from a project view, a path
// the enclosing store only infers — by slug or suffix — is not deleted there;
// and a path naming a stray fiber file out there reports the stray, in show
// as in rm, rather than resolving to its same-named twin.
func TestRmThroughViewRefusesEnclosingStoreGuesses(t *testing.T) {
	loomProj, subProj := newCrossStoreFixture(t)
	loom := felt.NewStorage(loomProj)
	writeFixtureFelt(t, loom, "commons/x", "X")
	writeFixtureFelt(t, loom, "commons/y/foo", "Twin foo")
	if err := os.WriteFile(filepath.Join(loom.Root(), "commons", "x", "foo.md"), []byte("---\nname: foo\nstatus: open\n---\n"), 0644); err != nil {
		t.Fatalf("write stray: %v", err)
	}

	for _, args := range [][]string{
		{"rm", "commons/x/foo"},
		{"show", "commons/x/foo", "--detail", "name"},
		{"edit", "commons/x/foo", "--status", "closed"},
	} {
		out, err := runCommand(t, subProj, args...)
		if err == nil || !strings.Contains(err.Error(), filepath.Join("commons", "x", "foo.md")+" holds fiber frontmatter") {
			t.Errorf("felt %v = %v\n%s; want the stray reported", args, err, out)
		}
	}

	// `charted` lives at ai-futures/portolan/charted: the enclosing store
	// reaches it from here only by its tail, which show accepts and rm does
	// not.
	out, err := runCommand(t, subProj, "rm", "charted")
	var guess *felt.GuessError
	if err == nil || !errors.As(err, &guess) || !strings.Contains(err.Error(), "did you mean ai-futures/portolan/charted (in ") {
		t.Fatalf("rm of an inferred external id = %v\n%s; want a did-you-mean refusal", err, out)
	}
	if out, err := runCommand(t, subProj, "show", "charted", "--detail", "name"); err != nil || !strings.Contains(out, "Charted") {
		t.Fatalf("show charted = %v\n%s; want the fiber", err, out)
	}
	for _, id := range []string{"commons/y/foo", "ai-futures/portolan/charted", "ai-futures/portolan/debug"} {
		if _, err := loom.Read(id); err != nil {
			t.Fatalf("%s was deleted: %v", id, err)
		}
	}
}

// TestRmThroughViewAcceptsLexicalPathOutThere: from a project view, a path
// that the enclosing store resolves by the lexical scope of the view's
// position — `portolan/debug` from ai-futures/felt is ai-futures/portolan/debug
// — is not a guess, so rm acts on it there.
func TestRmThroughViewAcceptsLexicalPathOutThere(t *testing.T) {
	loomProj, subProj := newCrossStoreFixture(t)
	out, err := runCommand(t, subProj, "rm", "portolan/debug")
	if err != nil || !strings.Contains(out, "Deleted ai-futures/portolan/debug") {
		t.Fatalf("rm portolan/debug = %v\n%s", err, out)
	}
	if _, err := felt.NewStorage(loomProj).Read("ai-futures/portolan/debug"); err == nil {
		t.Fatalf("outer fiber survived")
	}
}

// TestGettingStartedNestSequence runs the containment example from
// docs/getting-started.md: bare unique slugs are not guesses, so unnest and
// nest take them.
func TestGettingStartedNestSequence(t *testing.T) {
	dir, _ := newStore(t)
	for _, args := range [][]string{
		{"add", "covariance-estimation", "Covariance estimation", "-s", "open"},
		{"add", "covariance-estimation/jackknife-patches", "Jackknife patch count", "-s", "active"},
		{"add", "jackknife-patches/binning", "Binning choice"},
		{"unnest", "jackknife-patches"},
		{"nest", "jackknife-patches", "covariance-estimation"},
	} {
		if out, err := runCommand(t, dir, args...); err != nil {
			t.Fatalf("felt %v: %v\n%s", args, err, out)
		}
	}
	if _, err := felt.NewStorage(dir).Read("covariance-estimation/jackknife-patches/binning"); err != nil {
		t.Fatalf("subtree did not come back under its parent: %v", err)
	}
}

// TestExactOutsideIDBeatsLocalPrefixCompletion: an id written out in full
// names that fiber, even from a view holding a local id that merely begins
// with the same letters. `ai-futures/portolan/charted` exists out in the loom;
// the view holds `ai-futures/portolan/chartedx`. edit and show must reach the
// loom's fiber, and rm must act on it rather than call the query a guess.
func TestExactOutsideIDBeatsLocalPrefixCompletion(t *testing.T) {
	loomProj, subProj := newCrossStoreFixture(t)
	sub := felt.NewStorage(subProj)
	writeFixtureFelt(t, sub, "ai-futures/portolan/chartedx", "Local lookalike")

	out, err := runCommand(t, subProj, "show", "ai-futures/portolan/charted")
	if err != nil {
		t.Fatalf("show: %v\n%s", err, out)
	}
	if !strings.Contains(out, "Name:     Charted") {
		t.Fatalf("show answered with the local prefix completion:\n%s", out)
	}

	out, err = runCommand(t, subProj, "edit", "ai-futures/portolan/charted", "-s", "active")
	if err != nil {
		t.Fatalf("edit: %v\n%s", err, out)
	}
	if !strings.Contains(out, "Updated ai-futures/portolan/charted (in "+loomRoot(t, subProj)+")") {
		t.Fatalf("edit output = %q, want the loom's fiber", out)
	}
	if local, err := sub.Read("ai-futures/portolan/chartedx"); err != nil || local.Status != felt.StatusOpen {
		t.Fatalf("local lookalike was edited: %v %+v", err, local)
	}

	out, err = runCommand(t, subProj, "rm", "ai-futures/portolan/charted")
	if err != nil {
		t.Fatalf("rm: %v\n%s", err, out)
	}
	if _, err := felt.NewStorage(loomProj).Read("ai-futures/portolan/charted"); err == nil {
		t.Fatalf("rm did not delete the loom's fiber")
	}
	if _, err := sub.Read("ai-futures/portolan/chartedx"); err != nil {
		t.Fatalf("rm deleted the local lookalike: %v", err)
	}
}

// TestNestFromViewLeavesExactOutsideLinkAlone: a link that names the loom's
// `ai-futures/portolan/charted` outright is a link out of the view, however a
// local id begins. Moving the local lookalike must not rewrite it to follow
// the lookalike: the move plan reads paths by the same tiers resolution does.
func TestNestFromViewLeavesExactOutsideLinkAlone(t *testing.T) {
	_, subProj := newCrossStoreFixture(t)
	sub := felt.NewStorage(subProj)
	writeFixtureFelt(t, sub, "ai-futures/portolan/chartedx", "Local lookalike")
	citer := &felt.Felt{ID: "citer", Name: "Citer", Status: felt.StatusOpen, CreatedAt: time.Now(), Body: "see [[ai-futures/portolan/charted]]\n"}
	if err := sub.Write(citer); err != nil {
		t.Fatalf("write citer: %v", err)
	}

	if out, err := runCommand(t, subProj, "nest", "ai-futures/portolan/chartedx", "debug"); err != nil {
		t.Fatalf("nest: %v\n%s", err, out)
	}
	got, err := sub.Read("citer")
	if err != nil {
		t.Fatalf("read citer: %v", err)
	}
	if !strings.Contains(got.Body, "[[ai-futures/portolan/charted]]") {
		t.Fatalf("nest rewrote a link to the enclosing store's fiber:\n%s", got.Body)
	}
}

// writeConsumer writes a loom fiber whose inputs name from, once with an
// input id and once without: an entry with `from:` is a data-flow edge either
// way.
func writeConsumer(t *testing.T, s *felt.Storage, id, from string) {
	t.Helper()
	f := &felt.Felt{ID: id, Name: id, Status: felt.StatusOpen, CreatedAt: time.Now()}
	if err := f.SetExtraField("inputs", []map[string]any{
		{"id": "catalog", "from": from},
		{"from": from},
	}); err != nil {
		t.Fatalf("SetExtraField: %v", err)
	}
	if err := s.Write(f); err != nil {
		t.Fatalf("write %s: %v", id, err)
	}
}

func inputFroms(t *testing.T, s *felt.Storage, id string) []string {
	t.Helper()
	f, err := s.Read(id)
	if err != nil {
		t.Fatalf("read %s: %v", id, err)
	}
	var froms []string
	for _, item := range f.ExtraFields["inputs"].Content {
		for i := 0; i+1 < len(item.Content); i += 2 {
			if item.Content[i].Value == "from" {
				froms = append(froms, item.Content[i+1].Value)
			}
		}
	}
	return froms
}

// TestNestFromViewRewritesOutsideInputs: nest and unnest run inside a view
// rewrite inputs.from in the enclosing store's fibers outside the view, with
// or without an input id, in the enclosing store's coordinates.
func TestNestFromViewRewritesOutsideInputs(t *testing.T) {
	loomProj, subProj := newCrossStoreFixture(t)
	loom := felt.NewStorage(loomProj)
	writeConsumer(t, loom, "commons/reader", "ai-futures/felt/notes/runbook")

	if out, err := runCommand(t, subProj, "nest", "notes/runbook", "debug"); err != nil {
		t.Fatalf("nest: %v\n%s", err, out)
	}
	for _, from := range inputFroms(t, loom, "commons/reader") {
		if from != "ai-futures/felt/debug/runbook" {
			t.Fatalf("after nest, outside inputs = %v, want both at ai-futures/felt/debug/runbook", inputFroms(t, loom, "commons/reader"))
		}
	}

	if out, err := runCommand(t, subProj, "unnest", "debug/runbook"); err != nil {
		t.Fatalf("unnest: %v\n%s", err, out)
	}
	for _, from := range inputFroms(t, loom, "commons/reader") {
		if from != "ai-futures/felt/runbook" {
			t.Fatalf("after unnest, outside inputs = %v, want both at ai-futures/felt/runbook", inputFroms(t, loom, "commons/reader"))
		}
	}
}

// TestCheckFlagsStaleInputFromWithoutID: a stale inputs.from held up only by
// its last segment is warned on from the store root — the entry's input id
// is not what makes it an edge.
func TestCheckFlagsStaleInputFromWithoutID(t *testing.T) {
	loomProj, _ := newCrossStoreFixture(t)
	loom := felt.NewStorage(loomProj)
	writeConsumer(t, loom, "commons/reader", "ai-futures/felt/old/runbook")

	out, _ := runCommand(t, loomProj, "check")
	if got := strings.Count(out, `stale path in reference "ai-futures/felt/old/runbook"`); got != 2 {
		t.Fatalf("check warned on %d stale inputs.from, want 2 (with and without an id):\n%s", got, out)
	}
	if !strings.Contains(out, "inputs.catalog.from") || !strings.Contains(out, "inputs[1].from") {
		t.Fatalf("check should locate each entry, by id or by position:\n%s", out)
	}
}
