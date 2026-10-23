package transcriptindex

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSQLiteIncludesWALResetFix(t *testing.T) {
	i := testIndex(t)
	var version string
	if err := i.db.QueryRow("SELECT sqlite_version()").Scan(&version); err != nil {
		t.Fatal(err)
	}
	var major, minor, patch int
	if _, err := fmt.Sscanf(version, "%d.%d.%d", &major, &minor, &patch); err != nil {
		t.Fatal(err)
	}
	if major < 3 || (major == 3 && (minor < 51 || (minor == 51 && patch < 3))) {
		t.Fatalf("SQLite %s predates the WAL-reset corruption fix; use SQLite >=3.51.3", version)
	}
}

func TestEarlyCodexRolloutsKeepCanonicalMessages(t *testing.T) {
	i := testIndex(t)
	if err := i.IndexFile(ctx, fixture(t, "codex-early"), "codex"); err != nil {
		t.Fatal(err)
	}
	hits := search(t, i, "earlyneedle", Options{})
	if len(hits) != 3 {
		t.Fatalf("early native items lost: %+v", hits)
	}
	for _, hit := range hits {
		if hit.Session != "44444444-4444-4444-8444-444444444444" || hit.Timestamp != "" || hit.Project != "" {
			t.Fatalf("invented or missing provenance: %+v", hit)
		}
	}
}

func TestCodexEncodedArgumentsScrubBinaryAndSignatures(t *testing.T) {
	line := `{"type":"response_item","payload":{"type":"function_call","name":"inspect","arguments":"{\"path\":\"src/query.go\",\"image\":{\"data\":\"secretbinary\"},\"thinkingSignature\":\"secretsignature\"}"}}`
	msgs, err := parseLine("codex", []byte(line), &metadata{})
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 || !strings.Contains(msgs[0].Text, "src/query.go") || strings.Contains(msgs[0].Text, "secret") {
		t.Fatalf("arguments not scrubbed: %+v", msgs)
	}
}
func TestOpenTightensExistingDatabasePermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "index.sqlite")
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	i, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer i.Close()
	for _, suffix := range []string{"", "-wal", "-shm"} {
		info, err := os.Stat(path + suffix)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm()&0o077 != 0 {
			t.Errorf("%s mode %o", suffix, info.Mode().Perm())
		}
	}
}
func TestCatchUpPrunesDeletedFilesButNotUnavailableRoots(t *testing.T) {
	i := testIndex(t)
	p := fixture(t, "claude")
	root := Root{"claude", filepath.Dir(p)}
	if _, err := i.CatchUp(ctx, []Root{root}, false); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(p); err != nil {
		t.Fatal(err)
	}
	if _, err := i.CatchUp(ctx, []Root{root}, false); err != nil {
		t.Fatal(err)
	}
	if len(search(t, i, "VMPZ", Options{})) != 0 {
		t.Fatal("deleted transcript still searchable")
	}
	if err := os.WriteFile(p, []byte(userLine("retainedneedle")), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := i.CatchUp(ctx, []Root{root}, false); err != nil {
		t.Fatal(err)
	}
	gone := root.Path + "-unmounted"
	if err := os.Rename(root.Path, gone); err != nil {
		t.Fatal(err)
	}
	defer os.Rename(gone, root.Path)
	if _, err := i.CatchUp(ctx, []Root{root}, false); err != nil {
		t.Fatal(err)
	}
	if len(search(t, i, "retainedneedle", Options{})) != 1 {
		t.Fatal("unavailable root erased history")
	}
}
func TestGrowingPrefixRewriteWithUnchangedTail(t *testing.T) {
	i := testIndex(t)
	p := filepath.Join(t.TempDir(), "prefix.jsonl")
	first := userLine("oldneedle") + userLine(strings.Repeat("unchangedtail ", 100))
	if err := os.WriteFile(p, []byte(first), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := i.IndexFile(ctx, p, "claude"); err != nil {
		t.Fatal(err)
	}
	next := strings.Replace(first, "oldneedle", "newneedle", 1) + userLine("appended")
	if err := os.WriteFile(p, []byte(next), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := i.IndexFile(ctx, p, "claude"); err != nil {
		t.Fatal(err)
	}
	if len(search(t, i, "oldneedle", Options{})) != 0 || len(search(t, i, "newneedle", Options{})) != 1 {
		t.Fatal("prefix rewrite kept stale text")
	}
}
