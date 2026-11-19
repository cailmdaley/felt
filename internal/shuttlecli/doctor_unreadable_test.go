package shuttlecli

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDoctorNamesUnreadableFibers(t *testing.T) {
	t.Parallel()
	a := testApp(t)
	root := t.TempDir()
	broken := filepath.Join(root, ".felt", "hub", "hub.md")
	if err := os.MkdirAll(filepath.Dir(broken), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(broken, []byte("---\nname: Hub\noutcome: 'the chair's notes'\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	a.dir = root
	got := a.collectUnreadable()
	if len(got) != 1 || got[0].ID != "hub" || got[0].Error == "" {
		t.Fatalf("unreadable = %+v", got)
	}
}
