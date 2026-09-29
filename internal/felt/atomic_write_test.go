package felt

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestStorageWrite_ConcurrentReaderNeverSeesATruncatedFiber: the daemon's
// poll reads fibers while felt writes them, so every read must be the old
// document or the new one in full — never an in-place write's empty or
// partial file.
func TestStorageWrite_ConcurrentReaderNeverSeesATruncatedFiber(t *testing.T) {
	s := NewStorage(t.TempDir())
	if err := s.Init(); err != nil {
		t.Fatal(err)
	}
	versions := make(map[string]bool)
	docs := make([]*Felt, 2)
	for i := range docs {
		docs[i] = &Felt{ID: "f", Name: "f", Status: StatusOpen, Body: strings.Repeat(fmt.Sprintf("line %d of a long body\n", i), 20000)}
		data, err := docs[i].Marshal()
		if err != nil {
			t.Fatal(err)
		}
		versions[string(data)] = true
	}
	if err := s.Write(docs[0]); err != nil {
		t.Fatal(err)
	}

	path := s.Path("f")
	done := make(chan struct{})
	bad := make(chan string, 1)
	go func() {
		defer close(done)
		for i := 0; i < 400; i++ {
			got, err := os.ReadFile(path)
			if err != nil || !versions[string(got)] {
				bad <- fmt.Sprintf("read %d: %d bytes, err %v", i, len(got), err)
				return
			}
		}
	}()
	for i := 0; ; i++ {
		select {
		case <-done:
			select {
			case msg := <-bad:
				t.Fatalf("a concurrent reader saw neither version: %s", msg)
			default:
			}
			if left, _ := filepath.Glob(filepath.Join(filepath.Dir(path), ".*.tmp")); len(left) != 0 {
				t.Fatalf("temp files left behind: %v", left)
			}
			return
		default:
		}
		if err := s.Write(docs[i%2]); err != nil {
			t.Fatal(err)
		}
	}
}

// TestStorageWrite_KeepsAnExistingFilesMode: an atomic replacement installs a
// new file, which must not reset the mode the old one had.
func TestStorageWrite_KeepsAnExistingFilesMode(t *testing.T) {
	s := NewStorage(t.TempDir())
	if err := s.Init(); err != nil {
		t.Fatal(err)
	}
	f := &Felt{ID: "f", Name: "f", Status: StatusOpen}
	if err := s.Write(f); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(s.Path("f"))
	if err != nil || info.Mode().Perm() != 0o644 {
		t.Fatalf("new fiber mode = %v, %v; want 0644", info, err)
	}
	if err := os.Chmod(s.Path("f"), 0o600); err != nil {
		t.Fatal(err)
	}
	f.Body = "edited"
	if err := s.Write(f); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(s.Path("f")); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("rewritten fiber mode = %v, %v; want 0600 kept", info, err)
	}
}
