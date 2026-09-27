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
	return "---\nname: " + name + "\n---\n\n" + body + "\n"
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

	rewritten, err := s.MoveSubtree("a/x", "b/x")
	if err != nil {
		t.Fatalf("MoveSubtree: %v", err)
	}
	if want := []string{"c"}; !reflect.DeepEqual(rewritten, want) {
		t.Fatalf("rewritten = %v, want %v", rewritten, want)
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
	s := newMoveFixture(t)
	citing := "---\nname: C\n# a comment felt would not round-trip\nextra: [1, 2]\n---\n\nSee [[a/x]].\n"
	writeFiberFile(t, s, "c", citing)
	untouched := "---\nname: D\n---\n\nSee [[b]] and [[x]].\n"
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
	body := "[[one]] `[[code]]` [t](two#f) ```\n[[fenced]]\n``` [[three#s|label]]"
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
	if want := []string{"two", "one", "three"}; !reflect.DeepEqual(extracted, want) || !reflect.DeepEqual(seen, []string{"one", "two", "three"}) {
		t.Fatalf("extracted %v, rewrite saw %v", extracted, seen)
	}
	if want := "[[ONE]] `[[code]]` [t](TWO#f) ```\n[[fenced]]\n``` [[THREE#s|label]]"; out != want {
		t.Fatalf("rewritten = %q, want %q", out, want)
	}
}

func TestCheckWarnsOnStalePathLink(t *testing.T) {
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
	consumer := &Felt{ID: "c", Name: "C"}
	mustExtra(t, consumer, "inputs", []map[string]any{{"id": "in", "from": "a/x"}})
	issues := Check([]*Felt{{ID: "b", Name: "B"}, {ID: "b/x", Name: "X"}, consumer}, nil)
	if len(issues) != 1 || issues[0].Level != CheckLevelWarning || issues[0].Path != "inputs.in.from" {
		t.Fatalf("issues = %+v, want one stale-path warning on inputs.in.from", issues)
	}
}
