package shuttlecli

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPruneBoardCursorsRetainsActiveAndUnrelatedFiles(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	for _, name := range []string{"old.json", "recent.json", "unrelated.txt"} {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("{}"), 0600); err != nil {
			t.Fatal(err)
		}
		age := now.Add(-boardRetention - time.Hour)
		if name == "recent.json" {
			age = now.Add(-time.Hour)
		}
		if err := os.Chtimes(path, age, age); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(dir, "directory.json"), 0700); err != nil {
		t.Fatal(err)
	}
	pruneBoardCursors(dir, now)
	if _, err := os.Stat(filepath.Join(dir, "old.json")); !os.IsNotExist(err) {
		t.Fatalf("old cursor retained: %v", err)
	}
	for _, name := range []string{"recent.json", "unrelated.txt", "directory.json"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatal(err)
		}
	}
}
