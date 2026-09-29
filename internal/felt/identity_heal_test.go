package felt

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Every fiber write leaves the document with an intrinsic id: Storage.Write
// stamps the struct, and WriteFiberFile stamps raw content that lacks one.

func TestStorageWriteStampsMissingIntrinsicID(t *testing.T) {
	s := NewStorage(t.TempDir())
	if err := s.Init(); err != nil {
		t.Fatal(err)
	}
	f := &Felt{ID: "task", Name: "Task", Status: StatusOpen}
	if err := s.Write(f); err != nil {
		t.Fatal(err)
	}
	if !LooksLikeUID(f.UID) {
		t.Fatalf("Write left f.UID = %q, want a fresh ULID", f.UID)
	}
	got, err := s.Read("task")
	if err != nil {
		t.Fatal(err)
	}
	if got.UID != f.UID {
		t.Fatalf("file carries id %q, struct %q", got.UID, f.UID)
	}

	// A later write keeps the id it has.
	got.Name = "Renamed"
	if err := s.Write(got); err != nil {
		t.Fatal(err)
	}
	again, err := s.Read("task")
	if err != nil {
		t.Fatal(err)
	}
	if again.UID != f.UID {
		t.Fatalf("rewrite changed the id: %q -> %q", f.UID, again.UID)
	}
}

func TestWriteFiberFileStampsMissingIntrinsicID(t *testing.T) {
	path := filepath.Join(t.TempDir(), "f.md")
	if err := WriteFiberFile(path, []byte("---\nname: F\nstatus: open\n---\n\nbody\n")); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	f, err := Parse("f", data)
	if err != nil {
		t.Fatal(err)
	}
	if !LooksLikeUID(f.UID) {
		t.Fatalf("raw write left id %q, want a fresh ULID\n%s", f.UID, data)
	}
	if !strings.HasSuffix(string(data), "---\n\nbody\n") {
		t.Fatalf("body not preserved:\n%s", data)
	}
}

func TestWriteFiberFileFillsBlankIDInPlace(t *testing.T) {
	path := filepath.Join(t.TempDir(), "f.md")
	if err := WriteFiberFile(path, []byte("---\nid: \"\"\nname: F\n---\n")); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(string(data), "\nid:"); n != 1 {
		t.Fatalf("want exactly one id key, got %d:\n%s", n, data)
	}
	f, err := Parse("f", data)
	if err != nil {
		t.Fatal(err)
	}
	if !LooksLikeUID(f.UID) {
		t.Fatalf("blank id not filled: %q", f.UID)
	}
}

func TestWriteFiberFileLeavesExistingIDAndBytesAlone(t *testing.T) {
	path := filepath.Join(t.TempDir(), "f.md")
	content := "---\nid: 01KTHDNZS287ZSSG8X8V59XKWB\nname: F\n# kept verbatim\n---\n\nbody\n"
	if err := WriteFiberFile(path, []byte(content)); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != content {
		t.Fatalf("a document with an id must be written byte for byte:\n%s", data)
	}
}
