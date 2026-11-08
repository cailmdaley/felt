package shuttlecli

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPruneBoardCursorsRetainsActiveAndUnrelatedFiles(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	reach := 14 * 24 * time.Hour
	for _, name := range []string{"old.json", "recent.json", "unrelated.txt"} {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("{}"), 0600); err != nil {
			t.Fatal(err)
		}
		age := now.Add(-reach - time.Hour)
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
	pruneBoardCursors(dir, now, reach)
	if _, err := os.Stat(filepath.Join(dir, "old.json")); !os.IsNotExist(err) {
		t.Fatalf("old cursor retained: %v", err)
	}
	for _, name := range []string{"recent.json", "unrelated.txt", "directory.json"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatal(err)
		}
	}
}

func TestBoardDigestPrunesCursorsByTheReachTheDaemonServes(t *testing.T) {
	for _, tc := range []struct {
		name  string
		body  string
		keeps bool
	}{
		{"served reach", `{"family":null,"records":[],"reach_ms":3600000}`, false},
		{"no reach served", `{"family":null,"records":[]}`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := messageHookEnv(t, "host")
			daemonStub(t, env, map[string]http.HandlerFunc{"/api/v1/board/family": jsonBody(tc.body)})
			dir := filepath.Join(env.Getenv("SHUTTLE_DATA_DIR"), "board-cursors")
			if err := os.MkdirAll(dir, 0700); err != nil {
				t.Fatal(err)
			}
			old := filepath.Join(dir, "pi-other.json")
			if err := os.WriteFile(old, []byte("{}"), 0600); err != nil {
				t.Fatal(err)
			}
			age := time.Now().Add(-2 * time.Hour)
			if err := os.Chtimes(old, age, age); err != nil {
				t.Fatal(err)
			}
			newApp(env).boardDigest("pi", "s")
			if _, err := os.Stat(old); (err == nil) != tc.keeps {
				t.Fatalf("cursor kept=%v, want %v", err == nil, tc.keeps)
			}
		})
	}
}
