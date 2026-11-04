package feltcli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

// The daemon consumes the same cases through its real felt CLI boundary.
func TestNamespaceIdentityParity(t *testing.T) {
	t.Parallel()
	var fixture struct {
		Prefix  string                     `json:"prefix"`
		Fibers  []struct{ ID, UID string } `json:"fibers"`
		Lookups []struct {
			Query string
			ID    *string
		} `json:"lookups"`
		Creates []string `json:"creates"`
	}
	data, err := os.ReadFile("../../daemon/test/fixtures/fiber_identity/cases.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	root, st := newStore(t)
	for _, f := range fixture.Fibers {
		seedFiber(t, st, f.ID, f.UID, "open", nil, nil)
	}
	project := t.TempDir()
	if err := os.Symlink(filepath.Join(root, ".felt", filepath.FromSlash(fixture.Prefix)), filepath.Join(project, ".felt")); err != nil {
		t.Fatal(err)
	}
	for _, view := range []string{root, project} {
		t.Run(filepath.Base(view), func(t *testing.T) {
			namespace, err := filepath.EvalSymlinks(felt.NamespaceStorage(felt.NewStorage(view)).Root())
			if err != nil {
				t.Fatal(err)
			}
			wantRoot, err := filepath.EvalSymlinks(st.Root())
			if err != nil || namespace != wantRoot {
				t.Fatalf("namespace root = %s, want %s (%v)", namespace, wantRoot, err)
			}
			for _, lookup := range fixture.Lookups {
				out, _, err := executeCLI(t, view, "show", lookup.Query, "--exact", "-j")
				if lookup.ID == nil {
					if err == nil {
						t.Fatalf("%s resolved unexpectedly: %s", lookup.Query, out)
					}
					continue
				}
				if err != nil {
					t.Fatalf("%s: %v", lookup.Query, err)
				}
				var f felt.Felt
				if err := json.Unmarshal([]byte(out), &f); err != nil {
					t.Fatal(err)
				}
				if f.ID != *lookup.ID {
					t.Fatalf("%s resolved to %s, want %s", lookup.Query, f.ID, *lookup.ID)
				}
			}
			for _, id := range fixture.Creates {
				if _, _, err := executeCLI(t, view, "add", id, "Thread", "--namespace"); err != nil {
					t.Fatal(err)
				}
				if _, err := st.Read(id); err != nil {
					t.Fatalf("namespace create misplaced %s: %v", id, err)
				}
				if err := os.RemoveAll(filepath.Dir(st.Path(id))); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}
