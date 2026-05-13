package cmd

import (
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestIndexSyncCreatesIndexExplicitly(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	if err := storage.Write(&felt.Felt{ID: "target", Name: "Target"}); err != nil {
		t.Fatalf("Write(target) error: %v", err)
	}
	if err := storage.Write(&felt.Felt{ID: "source", Name: "Source", Body: "needle [[target]]"}); err != nil {
		t.Fatalf("Write(source) error: %v", err)
	}

	if storage.IndexExists() {
		t.Fatal("index should not exist before explicit sync")
	}

	out, err := runCommand(t, dir, "index", "sync")
	if err != nil {
		t.Fatalf("index sync failed: %v\n%s", err, out)
	}
	if !strings.Contains(out, "Synced index") {
		t.Fatalf("index sync output should report the maintenance action, got:\n%s", out)
	}
	if !storage.IndexExists() {
		t.Fatal("index sync should create index.db")
	}

	idx, err := storage.OpenIndexReadOnly()
	if err != nil {
		t.Fatalf("OpenIndexReadOnly() after sync error: %v", err)
	}
	defer idx.Close()
	citations, err := idx.Citations("target")
	if err != nil {
		t.Fatalf("Citations() error: %v", err)
	}
	if strings.Join(sourceIDs(citations), ",") != "source" {
		t.Fatalf("Citations() = %#v, want source citation", citations)
	}
}

func TestIndexSyncRefreshesStaleRelationshipCache(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	if err := storage.Write(&felt.Felt{ID: "target", Name: "Target"}); err != nil {
		t.Fatalf("Write(target) error: %v", err)
	}
	if err := storage.Write(&felt.Felt{ID: "source", Name: "Source", Body: "[[target]]"}); err != nil {
		t.Fatalf("Write(source) error: %v", err)
	}
	if out, err := runCommand(t, dir, "index", "sync"); err != nil {
		t.Fatalf("initial index sync failed: %v\n%s", err, out)
	}

	if err := storage.Write(&felt.Felt{ID: "later", Name: "Later", Body: "[[target]]"}); err != nil {
		t.Fatalf("Write(later) error: %v", err)
	}

	if out, err := runCommand(t, dir, "show", "target", "--citations"); err != nil {
		t.Fatalf("show --citations failed: %v\n%s", err, out)
	}
	citations := readOnlyCitations(t, storage, "target")
	if strings.Join(sourceIDs(citations), ",") != "source" {
		t.Fatalf("read-only citation lookup should not refresh a stale index implicitly: %#v", citations)
	}

	if out, err := runCommand(t, dir, "index", "sync"); err != nil {
		t.Fatalf("second index sync failed: %v\n%s", err, out)
	}
	citations = readOnlyCitations(t, storage, "target")
	if strings.Join(sourceIDs(citations), ",") != "later,source" {
		t.Fatalf("explicit index sync should refresh citation cache: %#v", citations)
	}
}

func readOnlyCitations(t *testing.T, storage *felt.Storage, targetID string) []felt.Citation {
	t.Helper()
	idx, err := storage.OpenIndexReadOnly()
	if err != nil {
		t.Fatalf("OpenIndexReadOnly() error: %v", err)
	}
	defer idx.Close()
	citations, err := idx.Citations(targetID)
	if err != nil {
		t.Fatalf("Citations(%q) error: %v", targetID, err)
	}
	return citations
}

func sourceIDs(citations []felt.Citation) []string {
	ids := make([]string, 0, len(citations))
	for _, citation := range citations {
		ids = append(ids, citation.SourceID)
	}
	return ids
}
