package feltcli

import (
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
			if !strings.Contains(stderr, "note: [[euclid]] resolved to work/euclid") || !strings.Contains(stderr, "full path") {
				t.Fatal(stderr)
			}
			if strings.Contains(stderr, "[[work/euclid]]") || strings.Contains(stderr, "unrelated") {
				t.Fatalf("unaffected references warned: %s", stderr)
			}
		})
	}
}

func TestNestWarnsAboutCapturedLinksAndRepairsThem(t *testing.T) {
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
	if !strings.Contains(stderr, "work/note: [[euclid]] resolved to work/euclid") {
		t.Fatal(stderr)
	}
	got := mustRead(t, s, "work/note")
	if !strings.Contains(got.Body, "[[work/euclid]]") {
		t.Fatalf("capture not repaired: %s", got.Body)
	}
}
