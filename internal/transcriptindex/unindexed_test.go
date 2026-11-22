package transcriptindex

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMarkedDirectoryLeavesTheIndex(t *testing.T) {
	i := testIndex(t)
	project := filepath.Join(t.TempDir(), "room")
	if e := os.MkdirAll(filepath.Join(project, "inner"), 0o700); e != nil {
		t.Fatal(e)
	}
	root := Root{"claude", t.TempDir()}
	path := filepath.Join(root.Path, "proj", "11111111-1111-4111-8111-111111111111.jsonl")
	if e := os.MkdirAll(filepath.Dir(path), 0o700); e != nil {
		t.Fatal(e)
	}
	line := func(text string) string {
		return `{"type":"user","sessionId":"11111111-1111-4111-8111-111111111111","cwd":"` + filepath.Join(project, "inner") + `","timestamp":"2026-10-01T12:00:00Z","message":{"role":"user","content":"` + text + `"}}` + "\n"
	}
	if e := os.WriteFile(path, []byte(line("lantern")), 0o600); e != nil {
		t.Fatal(e)
	}
	catchUp := func() {
		t.Helper()
		if _, e := i.CatchUp(ctx, []Root{root}, false); e != nil {
			t.Fatal(e)
		}
	}
	catchUp()
	if len(search(t, i, "lantern", Options{})) != 1 {
		t.Fatal("unmarked session should be searchable")
	}

	// Marking an ancestor drops what was already indexed, file unchanged.
	if e := os.WriteFile(filepath.Join(project, Marker), nil, 0o600); e != nil {
		t.Fatal(e)
	}
	catchUp()
	if h := search(t, i, "lantern", Options{}); len(h) != 0 {
		t.Fatalf("marked session still searchable: %+v", h)
	}

	// Appends to a marked session are never indexed.
	f, e := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if e != nil {
		t.Fatal(e)
	}
	f.WriteString(line("ember"))
	f.Close()
	if e := i.IndexFile(ctx, path, "claude"); e != nil {
		t.Fatal(e)
	}
	if h := search(t, i, "ember", Options{}); len(h) != 0 {
		t.Fatalf("append to marked session indexed: %+v", h)
	}
	var n int
	i.db.QueryRow("SELECT count(*) FROM messages").Scan(&n)
	if n != 0 {
		t.Fatalf("%d messages stored for a marked session", n)
	}
}

func TestLeavingAMarkedDirectoryDoesNotIndexTheSession(t *testing.T) {
	i := testIndex(t)
	marked, open := t.TempDir(), t.TempDir()
	if e := os.WriteFile(filepath.Join(marked, Marker), nil, 0o600); e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(t.TempDir(), "11111111-1111-4111-8111-111111111111.jsonl")
	line := func(cwd, text string) string {
		return `{"type":"user","sessionId":"11111111-1111-4111-8111-111111111111","cwd":"` + cwd + `","timestamp":"2026-10-01T12:00:00Z","message":{"role":"user","content":"` + text + `"}}` + "\n"
	}
	if e := os.WriteFile(path, []byte(line(open, "before")+line(marked, "lantern")+line(open, "ember")), 0o600); e != nil {
		t.Fatal(e)
	}
	if e := i.IndexFile(ctx, path, "claude"); e != nil {
		t.Fatal(e)
	}
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(line(open, "later"))
	f.Close()
	if e := i.IndexFile(ctx, path, "claude"); e != nil {
		t.Fatal(e)
	}
	var n int
	i.db.QueryRow("SELECT count(*) FROM messages").Scan(&n)
	if n != 0 {
		t.Fatalf("%d messages stored for a session that worked in a marked directory", n)
	}
}
