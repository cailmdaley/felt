package feltcli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestAddWarnsWhenNameChangesExistingLinks(t *testing.T) {
	t.Parallel()
	for _, id := range []string{"euclid", "other/euclid"} {
		t.Run(id, func(t *testing.T) {
			dir, s := newStore(t)
			for _, f := range []*felt.Felt{
				{ID: "work/euclid", Name: "Euclid"},
				{ID: "note", Name: "Note", Body: "[[euclid]] [[work/euclid]] [[unrelated]]"},
				{ID: "work/note", Name: "Scoped", Body: "[[euclid]]"},
			} {
				if err := s.Write(f); err != nil {
					t.Fatal(err)
				}
			}
			out, stderr, err := executeCLI(t, dir, "add", id, "New Euclid", "--top-level")
			if err != nil || strings.TrimSpace(out) != id {
				t.Fatalf("%s %s %v", out, stderr, err)
			}
			if !strings.Contains(stderr, "note: [[euclid]] pointed to work/euclid") || !strings.Contains(stderr, "in full") {
				t.Fatal(stderr)
			}
			if strings.Contains(stderr, "[[work/euclid]]") || strings.Contains(stderr, "unrelated") {
				t.Fatalf("unaffected references warned: %s", stderr)
			}
		})
	}
}

func TestAddWarnsWhenAResolvedPrefixBecomesAmbiguous(t *testing.T) {
	t.Parallel()
	dir, s := newStore(t)
	for _, f := range []*felt.Felt{
		{ID: "foreign/euclid-old", Name: "Original"},
		{ID: "reader", Name: "Reader", Body: "[[foreign/euclid]]"},
	} {
		if err := s.Write(f); err != nil {
			t.Fatal(err)
		}
	}
	_, stderr, err := executeCLI(t, dir, "add", "foreign/euclid/child/euclid", "New", "--top-level")
	if err != nil || !strings.Contains(stderr, "[[foreign/euclid]] pointed to foreign/euclid-old") || !strings.Contains(stderr, "ambiguous ID") {
		t.Fatalf("prefix ambiguity was not reported: %v: %s", err, stderr)
	}
}

func TestAddDoesNotWarnForADeadLinkBecomingValid(t *testing.T) {
	t.Parallel()
	dir, s := newStore(t)
	if err := s.Write(&felt.Felt{ID: "reader", Name: "Reader", Body: "[[future]]"}); err != nil {
		t.Fatal(err)
	}
	_, stderr, err := executeCLI(t, dir, "add", "future", "Future")
	if err != nil || stderr != "" {
		t.Fatalf("add: %v, stderr=%s", err, stderr)
	}
}

func TestAddReferenceInspectionFailureDoesNotBlockCreation(t *testing.T) {
	t.Parallel()
	dir, s := newStore(t)
	badPath := filepath.Join(s.Root(), "broken", "broken.md")
	if err := os.MkdirAll(filepath.Dir(badPath), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(badPath, []byte("---\nname: [future\n---\n"), 0644); err != nil {
		t.Fatal(err)
	}
	out, stderr, err := executeCLI(t, dir, "add", "future", "Future")
	if err != nil || strings.TrimSpace(out) != "future" {
		t.Fatalf("add: %v, %s, %s", err, out, stderr)
	}
	if strings.Count(stderr, "could not inspect all existing references") != 1 {
		t.Fatal(stderr)
	}
	if _, err := s.Read("future"); err != nil {
		t.Fatal(err)
	}
}

func TestNestDoesNotWarnAboutLinksItRepairs(t *testing.T) {
	t.Parallel()
	dir, s := newStore(t)
	for _, f := range []*felt.Felt{
		{ID: "work/euclid", Name: "Original"},
		{ID: "other/euclid", Name: "New"},
		{ID: "note", Name: "Note", Body: "[[work/euclid]] [[work/euclid#thing]]"},
		{ID: "work/note", Name: "Scoped", Body: "[[euclid]]"},
	} {
		if err := s.Write(f); err != nil {
			t.Fatal(err)
		}
	}
	f := &felt.Felt{ID: "reader", Name: "Reader", Body: "[[other/euclid]]"}
	if err := s.Write(f); err != nil {
		t.Fatal(err)
	}
	// Move a fiber into the source's scope: the existing link points at work/euclid.
	_, stderr, err := executeCLI(t, dir, "nest", "other/euclid", "work/note")
	if err != nil {
		t.Fatalf("%v: %s", err, stderr)
	}
	if stderr != "" {
		t.Fatalf("repaired link must not warn: %s", stderr)
	}
	got := mustRead(t, s, "work/note")
	if !strings.Contains(got.Body, "[[work/euclid]]") {
		t.Fatalf("capture not repaired: %s", got.Body)
	}
}
