package feltcli

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
)

// Store and fiber fixtures shared across the package's tests.

func seedFiber(t *testing.T, storage *felt.Storage, id, uid, status string, block map[string]any, tempered *bool) {
	t.Helper()
	fiber := &felt.Felt{ID: id, UID: uid, Name: id, Status: status}
	if block != nil {
		if err := fiber.SetExtraField("shuttle", block); err != nil {
			t.Fatalf("SetExtraField: %v", err)
		}
	}
	if tempered != nil {
		if err := fiber.SetExtraField("tempered", *tempered); err != nil {
			t.Fatalf("SetExtraField: %v", err)
		}
	}
	if err := storage.Write(fiber); err != nil {
		t.Fatalf("Write %s: %v", id, err)
	}
}

func mustRead(t *testing.T, storage *felt.Storage, id string) *felt.Felt {
	t.Helper()
	fiber, err := storage.Read(id)
	if err != nil {
		t.Fatalf("Read %s: %v", id, err)
	}
	return fiber
}

func newStore(t *testing.T) (string, *felt.Storage) {
	t.Helper()
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	return dir, storage
}

// newCrossStoreFixture builds the loom shape: an enclosing store, a project
// whose `.felt` is a symlink into a subdirectory of it, and fibers on both
// sides — including a same-slug pair (`debug` here, `ai-futures/portolan/debug`
// out there) so every test exercises the case that used to misresolve.
func newCrossStoreFixture(t *testing.T) (loomProj, subProj string) {
	t.Helper()
	tmp := t.TempDir()

	loomProj = filepath.Join(tmp, "loom")
	loom := felt.NewStorage(loomProj)
	if err := loom.Init(); err != nil {
		t.Fatalf("loom init: %v", err)
	}
	writeFixtureFelt(t, loom, "ai-futures/portolan/debug", "Portolan debug")
	tagged := &felt.Felt{ID: "ai-futures/portolan/charted", Name: "Charted", Tags: []string{"decision"}, Status: felt.StatusOpen, CreatedAt: time.Now()}
	if err := loom.Write(tagged); err != nil {
		t.Fatalf("write tagged fiber: %v", err)
	}
	writeFixtureFelt(t, loom, "commons", "Commons")

	content := filepath.Join(loomProj, ".felt", "ai-futures", "felt")
	if err := os.MkdirAll(content, 0755); err != nil {
		t.Fatalf("mkdir substore content: %v", err)
	}
	subProj = filepath.Join(tmp, "project")
	if err := os.MkdirAll(subProj, 0755); err != nil {
		t.Fatalf("mkdir project: %v", err)
	}
	if err := os.Symlink(content, filepath.Join(subProj, ".felt")); err != nil {
		t.Fatalf("symlink substore: %v", err)
	}
	sub := felt.NewStorage(subProj)
	writeFixtureFelt(t, sub, "debug", "Local debug")
	writeFixtureFelt(t, sub, "notes/runbook", "Runbook")
	return loomProj, subProj
}

func writeFixtureFelt(t *testing.T, s *felt.Storage, id, name string) {
	t.Helper()
	if err := s.Write(&felt.Felt{ID: id, Name: name, Status: felt.StatusOpen, CreatedAt: time.Now()}); err != nil {
		t.Fatalf("write %s: %v", id, err)
	}
}

func loomRoot(t *testing.T, subProj string) string {
	t.Helper()
	root, _, ok := felt.NewStorage(subProj).EnclosingStore()
	if !ok {
		t.Fatalf("fixture project is not a substore")
	}
	return root
}

// writeConsumer writes a loom fiber whose inputs name from, once with an
// input id and once without: an entry with `from:` is a data-flow edge either
// way.
func writeConsumer(t *testing.T, s *felt.Storage, id, from string) {
	t.Helper()
	f := &felt.Felt{ID: id, Name: id, Status: felt.StatusOpen, CreatedAt: time.Now()}
	if err := f.SetExtraField("inputs", []map[string]any{
		{"id": "catalog", "from": from},
		{"from": from},
	}); err != nil {
		t.Fatalf("SetExtraField: %v", err)
	}
	if err := s.Write(f); err != nil {
		t.Fatalf("write %s: %v", id, err)
	}
}

func inputFroms(t *testing.T, s *felt.Storage, id string) []string {
	t.Helper()
	f, err := s.Read(id)
	if err != nil {
		t.Fatalf("read %s: %v", id, err)
	}
	var froms []string
	for _, item := range f.ExtraFields["inputs"].Content {
		for i := 0; i+1 < len(item.Content); i += 2 {
			if item.Content[i].Value == "from" {
				froms = append(froms, item.Content[i+1].Value)
			}
		}
	}
	return froms
}

// writeBrokenFiber plants a fiber dir whose `<slug>.md` holds the given raw
// bytes, bypassing storage so unparseable frontmatter can reach disk.
func writeBrokenFiber(t *testing.T, dir, slug string, content []byte) {
	t.Helper()
	badDir := filepath.Join(dir, ".felt", slug, slug)
	if err := os.MkdirAll(badDir, 0755); err != nil {
		t.Fatalf("MkdirAll %s fiber dir: %v", slug, err)
	}
	if err := os.WriteFile(filepath.Join(badDir, slug+".md"), content, 0644); err != nil {
		t.Fatalf("WriteFile %s fiber: %v", slug, err)
	}
}

func mustShowExtra(t *testing.T, f *felt.Felt, key string, value any) {
	t.Helper()
	if err := f.SetExtraField(key, value); err != nil {
		t.Fatalf("SetExtraField(%s): %v", key, err)
	}
}

func mustParseTime(t *testing.T, value string) time.Time {
	t.Helper()
	ts, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatalf("parse time %q: %v", value, err)
	}
	return ts
}

func seedShuttleFiber(t *testing.T, storage *felt.Storage, id string, block map[string]any) {
	t.Helper()
	seedFiber(t, storage, id, "", "", block, nil)
}

// repoRoot walks up from the test's working directory until it finds go.mod.
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("could not find repo root (no go.mod)")
		}
		dir = parent
	}
}
