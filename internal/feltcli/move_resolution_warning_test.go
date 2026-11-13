package feltcli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestMoveWarnsOnlyAboutLinksItLeavesChanged(t *testing.T) {
	t.Parallel()
	outer, outerStorage := newStore(t)
	if err := outerStorage.Write(&felt.Felt{ID: "foreign/target", Name: "Outer target"}); err != nil {
		t.Fatal(err)
	}
	_, local := newStore(t)
	for _, f := range []*felt.Felt{
		{ID: "other/target", Name: "Local target"},
		{ID: "source", Name: "Source", Body: "[[foreign/target]] [[other/target]]"},
	} {
		if err := local.Write(f); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(local.Root(), "foreign"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(local.Root(), filepath.Join(outer, ".felt", "shared")); err != nil {
		t.Fatal(err)
	}
	view := t.TempDir()
	if err := os.Symlink(filepath.Join(outer, ".felt", "shared"), filepath.Join(view, ".felt")); err != nil {
		t.Fatal(err)
	}
	_, stderr, err := executeCLI(t, view, "nest", "other/target", "foreign")
	if err != nil {
		t.Fatalf("%v: %s", err, stderr)
	}
	if !strings.Contains(stderr, "The move left these references with changed resolution:") || !strings.Contains(stderr, "source: [[foreign/target]] resolved to foreign/target (enclosing store)") {
		t.Fatal(stderr)
	}
	if strings.Contains(stderr, "[[other/target]]") {
		t.Fatalf("repaired reference warned: %s", stderr)
	}
	got := mustRead(t, local, "source").Body
	if got != "[[foreign/target]] [[foreign/target]]" {
		t.Fatalf("unexpected rewrite: %s", got)
	}
}
