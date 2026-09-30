package feltcli

import (
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

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
