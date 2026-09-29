package atomicfile

import (
	"os"
	"path/filepath"
	"testing"
)

func mode(t *testing.T, path string) os.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Mode().Perm()
}

func leftovers(t *testing.T, dir string) []string {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(dir, ".*.tmp"))
	if err != nil {
		t.Fatal(err)
	}
	return matches
}

// TestWrite_SetsTheIntendedModeAndLeavesNoTemp: os.CreateTemp makes 0600;
// the installed file carries the mode asked for.
func TestWrite_SetsTheIntendedModeAndLeavesNoTemp(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.md")
	if err := Write(path, []byte("one"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := mode(t, path); got != 0o644 {
		t.Fatalf("mode = %o, want 644", got)
	}
	if err := Write(path, []byte("two"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(path); string(got) != "two" {
		t.Fatalf("content = %q", got)
	}
	if got := mode(t, path); got != 0o600 {
		t.Fatalf("mode = %o, want 600", got)
	}
	if left := leftovers(t, dir); len(left) != 0 {
		t.Fatalf("temp files left behind: %v", left)
	}
}

// TestWrite_FollowsASymlink: like os.WriteFile, a symlinked target has the
// file it names replaced, and the link survives.
func TestWrite_FollowsASymlink(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "real.md")
	link := filepath.Join(dir, "link.md")
	if err := os.WriteFile(real, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	if err := Write(link, []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Lstat(link); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("the link was replaced: %v, %v", info, err)
	}
	if got, _ := os.ReadFile(real); string(got) != "new" {
		t.Fatalf("target content = %q", got)
	}
}

// TestCreate_AbortLeavesTheTargetAndNoTemp — and names its temp file so
// IsTemp recognizes it.
func TestCreate_AbortLeavesTheTargetAndNoTemp(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.md")
	if err := os.WriteFile(path, []byte("kept"), 0o644); err != nil {
		t.Fatal(err)
	}
	f, err := Create(path, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if !IsTemp(filepath.Base(f.Name()), "a.md") {
		t.Fatalf("IsTemp does not recognize %s", f.Name())
	}
	if _, err := f.Write([]byte("discarded")); err != nil {
		t.Fatal(err)
	}
	f.Abort()
	f.Abort()
	if got, _ := os.ReadFile(path); string(got) != "kept" {
		t.Fatalf("content = %q", got)
	}
	if left := leftovers(t, dir); len(left) != 0 {
		t.Fatalf("temp files left behind: %v", left)
	}
	if err := f.Commit(); err == nil {
		t.Fatal("Commit after Abort succeeded")
	}
}
