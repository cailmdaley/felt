// Package felttest holds the store and fiber fixtures the CLI packages'
// tests share.
package felttest

import (
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
)

// SeededAt is the creation time Seed stamps on every fiber.
var SeededAt = time.Date(2026, 4, 10, 9, 0, 0, 0, time.UTC)

// NewStore initializes a felt store in a fresh temp dir.
func NewStore(t testing.TB) (string, *felt.Storage) {
	t.Helper()
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	return dir, storage
}

// Seed writes a fiber straight through storage, bypassing the command
// layer's validation, so a deliberately invalid shuttle block can reach disk.
// A nil block or tempered leaves that field out.
func Seed(t testing.TB, storage *felt.Storage, id, uid, status string, block map[string]any, tempered *bool) {
	t.Helper()
	f := &felt.Felt{ID: id, UID: uid, Name: id, Status: status, CreatedAt: SeededAt}
	if block != nil {
		if err := f.SetExtraField("shuttle", block); err != nil {
			t.Fatalf("SetExtraField shuttle: %v", err)
		}
	}
	if tempered != nil {
		if err := f.SetExtraField("tempered", *tempered); err != nil {
			t.Fatalf("SetExtraField tempered: %v", err)
		}
	}
	if err := storage.Write(f); err != nil {
		t.Fatalf("Write %s: %v", id, err)
	}
}

// MustRead reads a fiber or fails the test.
func MustRead(t testing.TB, storage *felt.Storage, id string) *felt.Felt {
	t.Helper()
	f, err := storage.Read(id)
	if err != nil {
		t.Fatalf("Read %s: %v", id, err)
	}
	return f
}
