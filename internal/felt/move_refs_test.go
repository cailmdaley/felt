package felt

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// writeFiberFile plants a fiber's markdown exactly as given, so a test can
// see whether a move rewrote a file byte for byte.
func writeFiberFile(t *testing.T, s *Storage, id, content string) {
	t.Helper()
	path := filepath.Join(s.root, filepath.FromSlash(id), filepath.Base(id)+FileExt)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("mkdir %s: %v", id, err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("write %s: %v", id, err)
	}
}

func readFiberFile(t *testing.T, s *Storage, id string) string {
	t.Helper()
	data, err := os.ReadFile(s.Path(id))
	if err != nil {
		t.Fatalf("read %s: %v", id, err)
	}
	return string(data)
}

func fiber(name, body string) string {
	return "---\nid: fixture-" + name + "\nname: " + name + "\n---\n\n" + body + "\n"
}

// newMoveFixture is the store every move test starts from: a, b, a/x with a
// child a/x/y, and a sibling a/xy whose name begins with x.
func newMoveFixture(t *testing.T) *Storage {
	t.Helper()
	_, s := newStore(t)
	for _, id := range []string{"a", "b", "a/x", "a/x/y", "a/xy"} {
		writeFiberFile(t, s, id, fiber(strings.ToUpper(filepath.Base(id)), ""))
	}
	return s
}

func TestMoveSubtreeRewritesBodyLinks(t *testing.T) {
	t.Parallel()
	s := newMoveFixture(t)
	writeFiberFile(t, s, "c", fiber("C", strings.Join([]string{
		"Moved: [[a/x]].",
		"Descendant: [[a/x/y]].",
		"Fragment and label: [[a/x#sec|the prior]].",
		"Markdown: [the prior](a/x/y).",
		"Bare slug: [[x]].",
		"Sibling: [[a/xy]].",
		"Unrelated: [[b]].",
		"Code: `[[a/x]]`.",
		"```",
		"[[a/x/y]]",
		"```",
	}, "\n")))

	result, err := s.MoveSubtree("a/x", "b/x")
	if err != nil {
		t.Fatalf("MoveSubtree: %v", err)
	}
	if want := []string{"c"}; !reflect.DeepEqual(result.Rewritten, want) || len(result.Outside) != 0 {
		t.Fatalf("result = %+v, want Rewritten %v", result, want)
	}

	want := fiber("C", strings.Join([]string{
		"Moved: [[b/x]].",
		"Descendant: [[b/x/y]].",
		"Fragment and label: [[b/x#sec|the prior]].",
		"Markdown: [the prior](b/x/y).",
		"Bare slug: [[x]].",
		"Sibling: [[a/xy]].",
		"Unrelated: [[b]].",
		"Code: `[[a/x]]`.",
		"```",
		"[[a/x/y]]",
		"```",
	}, "\n"))
	if got := readFiberFile(t, s, "c"); got != want {
		t.Fatalf("c.md after move:\n%s\nwant:\n%s", got, want)
	}
}

// A file that needs no change is not written, and a rewritten file keeps its
// frontmatter as written: a hand-made fiber without created-at is never
// stamped with the zero time.
func TestMoveSubtreeWritesOnlyChangedFiles(t *testing.T) {
	t.Parallel()
	s := newMoveFixture(t)
	citing := "---\nid: fixture-C\nname: C\n# a comment felt would not round-trip\nextra: [1, 2]\n---\n\nSee [[a/x]].\n"
	writeFiberFile(t, s, "c", citing)
	untouched := "---\nid: fixture-D\nname: D\n---\n\nSee [[b]] and [[x]].\n"
	writeFiberFile(t, s, "d", untouched)
	movedContent := readFiberFile(t, s, "a/x/y")

	if _, err := s.MoveSubtree("a/x", "b/x"); err != nil {
		t.Fatalf("MoveSubtree: %v", err)
	}

	if got, want := readFiberFile(t, s, "c"), strings.Replace(citing, "[[a/x]]", "[[b/x]]", 1); got != want {
		t.Fatalf("c.md = %q, want %q", got, want)
	}
	if got := readFiberFile(t, s, "d"); got != untouched {
		t.Fatalf("d.md rewritten: %q", got)
	}
	if got := readFiberFile(t, s, "b/x/y"); got != movedContent {
		t.Fatalf("moved fiber rewritten: %q, was %q", got, movedContent)
	}
	for _, id := range []string{"c", "d", "b/x/y"} {
		if strings.Contains(readFiberFile(t, s, id), "created-at") {
			t.Fatalf("%s gained a created-at", id)
		}
	}
}

func TestMarshalOmitsUnsetCreatedAt(t *testing.T) {
	t.Parallel()
	data, err := (&Felt{ID: "c", Name: "C"}).Marshal()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "created-at") {
		t.Fatalf("Marshal wrote a zero created-at:\n%s", data)
	}
}

// Unnest runs through the same rewrite: a/x promoted to x.
func TestMoveSubtreeUnnestRewritesLinks(t *testing.T) {
	t.Parallel()
	s := newMoveFixture(t)
	writeFiberFile(t, s, "c", fiber("C", "See [[a/x]], [[a/x/y#k]] and [[a/xy]]."))

	if _, err := s.MoveSubtree("a/x", "x"); err != nil {
		t.Fatalf("MoveSubtree: %v", err)
	}
	if got, want := readFiberFile(t, s, "c"), fiber("C", "See [[x]], [[x/y#k]] and [[a/xy]]."); got != want {
		t.Fatalf("c.md = %q, want %q", got, want)
	}
}

// Links inside the moved subtree move with it: a scope-relative link that
// still resolves after the move is left alone, while one reaching back out
// through the old parent is rewritten.
func TestMoveSubtreeRewritesLinksFromInsideTheSubtree(t *testing.T) {
	t.Parallel()
	s := newMoveFixture(t)
	writeFiberFile(t, s, "a/q", fiber("Q", ""))
	writeFiberFile(t, s, "a/x/y", fiber("Y", "Parent [[a/x]], sibling-of-parent [[a/q]], self [[x/y]]."))

	if _, err := s.MoveSubtree("a/x", "b/x"); err != nil {
		t.Fatalf("MoveSubtree: %v", err)
	}
	if got, want := readFiberFile(t, s, "b/x/y"), fiber("Y", "Parent [[b/x]], sibling-of-parent [[a/q]], self [[x/y]]."); got != want {
		t.Fatalf("y.md = %q, want %q", got, want)
	}
}

// A path written relative to a scope keeps that shape when the destination is
// still under the same scope.
func TestMoveSubtreeKeepsScopeRelativeSpelling(t *testing.T) {
	t.Parallel()
	_, s := newStore(t)
	for _, id := range []string{"p", "p/a", "p/a/x", "p/b", "p/c", "q"} {
		writeFiberFile(t, s, id, fiber(id, ""))
	}
	// Two x's anywhere in the store, so neither the unique-suffix nor the
	// basename rescue can carry a stale `a/x`.
	writeFiberFile(t, s, "q/x", fiber("other x", ""))
	writeFiberFile(t, s, "p/c", fiber("C", "See [[a/x]]."))

	if _, err := s.MoveSubtree("p/a/x", "p/b/x"); err != nil {
		t.Fatalf("MoveSubtree: %v", err)
	}
	if got, want := readFiberFile(t, s, "p/c"), fiber("C", "See [[b/x]]."); got != want {
		t.Fatalf("c.md = %q, want %q", got, want)
	}
}

func TestExtractBodyRefsAgreesWithRewrite(t *testing.T) {
	t.Parallel()
	body := "[[one]] `[[code]]` [t](two#f) ```\n[[fenced]]\n``` [[three#s|label]] [`four`](four) `[x](not)`"
	var seen []string
	out, changed := RewriteBodyRefs(body, func(target string) (string, bool) {
		seen = append(seen, target)
		return strings.ToUpper(target), true
	})
	if !changed {
		t.Fatal("RewriteBodyRefs reported no change")
	}
	var extracted []string
	for _, ref := range ExtractBodyRefs(body) {
		extracted = append(extracted, ref.Target)
	}
	if want := []string{"two", "four", "one", "three"}; !reflect.DeepEqual(extracted, want) || !reflect.DeepEqual(seen, []string{"one", "two", "three", "four"}) {
		t.Fatalf("extracted %v, rewrite saw %v", extracted, seen)
	}
	if want := "[[ONE]] `[[code]]` [t](TWO#f) ```\n[[fenced]]\n``` [[THREE#s|label]] [`four`](FOUR) `[x](not)`"; out != want {
		t.Fatalf("rewritten = %q, want %q", out, want)
	}
}

func TestCheckWarnsOnStalePathLink(t *testing.T) {
	t.Parallel()
	felts := []*Felt{
		{ID: "b", Name: "B"},
		{ID: "b/x", Name: "X"},
		{ID: "c", Name: "C", Body: "Stale [[a/x]], correct [[b/x]], bare [[x]]."},
	}
	issues := Check(felts, nil)
	if len(issues) != 1 {
		t.Fatalf("issues = %+v, want exactly the stale path", issues)
	}
	issue := issues[0]
	if issue.Level != CheckLevelWarning || issue.FiberID != "c" || issue.Path != "body" ||
		!strings.Contains(issue.Message, `"a/x"`) || !strings.Contains(issue.Message, "b/x") {
		t.Fatalf("issue = %+v", issue)
	}
}

func TestCheckWarnsOnStalePathDataFlowRef(t *testing.T) {
	t.Parallel()
	consumer := &Felt{ID: "c", Name: "C"}
	mustExtra(t, consumer, "inputs", []map[string]any{{"id": "in", "from": "a/x"}})
	issues := Check([]*Felt{{ID: "b", Name: "B"}, {ID: "b/x", Name: "X"}, consumer}, nil)
	if len(issues) != 1 || issues[0].Level != CheckLevelWarning || issues[0].Path != "inputs.in.from" {
		t.Fatalf("issues = %+v, want one stale-path warning on inputs.in.from", issues)
	}
}

// A top-level fiber's bare slug is its full path, but nesting it leaves the
// slug resolving by path (it is still unique), so the link stays as written.
func TestMoveSubtreeLeavesTopLevelBareSlugThatStillResolves(t *testing.T) {
	t.Parallel()
	s := newMoveFixture(t)
	writeFiberFile(t, s, "solo", fiber("Solo", ""))
	citing := fiber("C", "See [[solo]] and [[solo#k|it]].")
	writeFiberFile(t, s, "c", citing)

	result, err := s.MoveSubtree("solo", "b/solo")
	if err != nil {
		t.Fatalf("MoveSubtree: %v", err)
	}
	if len(result.Rewritten) != 0 || readFiberFile(t, s, "c") != citing {
		t.Fatalf("rewritten %v; c.md = %q", result.Rewritten, readFiberFile(t, s, "c"))
	}
}

// A bare slug that resolved through its scope and that the move breaks — the
// slug is not unique, so nothing carries it to the new place — is rewritten
// to the fiber's full new id.
func TestMoveSubtreeRewritesBareSlugTheMoveBreaks(t *testing.T) {
	t.Parallel()
	s := newMoveFixture(t)
	writeFiberFile(t, s, "q/x", fiber("Another x", ""))
	writeFiberFile(t, s, "a/c", fiber("C", "See [[x]]."))

	if _, err := s.MoveSubtree("a/x", "b/x"); err != nil {
		t.Fatalf("MoveSubtree: %v", err)
	}
	if got, want := readFiberFile(t, s, "a/c"), fiber("C", "See [[b/x]]."); got != want {
		t.Fatalf("c.md = %q, want %q", got, want)
	}
}

// newCaptureFixture holds a/sib linking [[x]], which names a/xy by prefix
// through its scope, and a fiber b/x the move tests carry around.
func newCaptureFixture(t *testing.T) (*Storage, string) {
	t.Helper()
	_, s := newStore(t)
	for _, id := range []string{"a", "a/xy", "b", "b/x", "c"} {
		writeFiberFile(t, s, id, fiber(strings.ToUpper(filepath.Base(id)), ""))
	}
	citing := fiber("Sib", "See [[x]] and [[x#k|it]].")
	writeFiberFile(t, s, "a/sib", citing)
	return s, citing
}

// A move that brings a fiber named x into a/ would make a/sib's [[x]] name it
// instead of a/xy; the link is pinned to the fiber it named.
func TestMoveSubtreePinsLinkTheMoveWouldCapture(t *testing.T) {
	t.Parallel()
	s, _ := newCaptureFixture(t)

	result, err := s.MoveSubtree("b/x", "a/x")
	if err != nil {
		t.Fatalf("MoveSubtree: %v", err)
	}
	if got, want := readFiberFile(t, s, "a/sib"), fiber("Sib", "See [[a/xy]] and [[a/xy#k|it]]."); got != want {
		t.Fatalf("sib.md = %q, want %q", got, want)
	}
	if !reflect.DeepEqual(result.Rewritten, []string{"a/sib"}) {
		t.Fatalf("rewritten = %v", result.Rewritten)
	}
}

// A move elsewhere leaves [[x]] naming a/xy, so nothing is written.
func TestMoveSubtreeLeavesLinkTheMoveDoesNotCapture(t *testing.T) {
	t.Parallel()
	s, citing := newCaptureFixture(t)

	result, err := s.MoveSubtree("b/x", "c/x")
	if err != nil {
		t.Fatalf("MoveSubtree: %v", err)
	}
	if len(result.Rewritten) != 0 || readFiberFile(t, s, "a/sib") != citing {
		t.Fatalf("rewritten %v; sib.md = %q", result.Rewritten, readFiberFile(t, s, "a/sib"))
	}
}
