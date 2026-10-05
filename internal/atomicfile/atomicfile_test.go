package atomicfile

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
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
	t.Parallel()
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
	t.Parallel()
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
	t.Parallel()
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

// writers are the two strengths; each semantic test runs against both.
var writers = map[string]func(string, []byte, os.FileMode) error{
	"Write":         Write,
	"WriteUnsynced": WriteUnsynced,
}

// TestWriteUnsynced_ReplacesLikeWrite: skipping fsync changes durability
// only — mode, symlink following and temp cleanup are the same.
func TestWriteUnsynced_ReplacesLikeWrite(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	real := filepath.Join(dir, "real.md")
	link := filepath.Join(dir, "link.md")
	if err := WriteUnsynced(real, []byte("old"), 0o640); err != nil {
		t.Fatal(err)
	}
	if got := mode(t, real); got != 0o640 {
		t.Fatalf("mode = %o, want 640", got)
	}
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	if err := WriteUnsynced(link, []byte("new"), 0o640); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Lstat(link); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("the link was replaced: %v, %v", info, err)
	}
	if got, _ := os.ReadFile(real); string(got) != "new" {
		t.Fatalf("target content = %q", got)
	}
	if left := leftovers(t, dir); len(left) != 0 {
		t.Fatalf("temp files left behind: %v", left)
	}
}

// TestWrite_InodeSwapSemantics pins the documented differences from an
// in-place os.WriteFile: a read-only file in a writable directory is
// replaced, a hard link keeps the old content, and a dangling symlink is
// replaced by a regular file.
func TestWrite_InodeSwapSemantics(t *testing.T) {
	t.Parallel()
	for name, write := range writers {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()

			readOnly := filepath.Join(dir, "ro.md")
			if err := os.WriteFile(readOnly, []byte("old"), 0o444); err != nil {
				t.Fatal(err)
			}
			if err := write(readOnly, []byte("new"), 0o444); err != nil {
				t.Fatalf("read-only file in a writable dir: %v", err)
			}
			if got, _ := os.ReadFile(readOnly); string(got) != "new" {
				t.Fatalf("read-only content = %q", got)
			}

			orig := filepath.Join(dir, "orig.md")
			hard := filepath.Join(dir, "hard.md")
			if err := os.WriteFile(orig, []byte("old"), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.Link(orig, hard); err != nil {
				t.Fatal(err)
			}
			if err := write(orig, []byte("new"), 0o644); err != nil {
				t.Fatal(err)
			}
			if got, _ := os.ReadFile(hard); string(got) != "old" {
				t.Fatalf("hard link content = %q, want the old inode's", got)
			}

			dangling := filepath.Join(dir, "dangling.md")
			if err := os.Symlink(filepath.Join(dir, "missing.md"), dangling); err != nil {
				t.Fatal(err)
			}
			if err := write(dangling, []byte("new"), 0o644); err != nil {
				t.Fatal(err)
			}
			if info, err := os.Lstat(dangling); err != nil || !info.Mode().IsRegular() {
				t.Fatalf("dangling symlink not replaced by a regular file: %v, %v", info, err)
			}
			if _, err := os.Lstat(filepath.Join(dir, "missing.md")); !os.IsNotExist(err) {
				t.Fatalf("the dangling link's target was created: %v", err)
			}
		})
	}
}

// BenchmarkBulkRewrite rewrites a batch of fiber-sized files, the shape of a
// store-wide migration, reporting the cost per file of each writer.
//
//	go test ./internal/atomicfile -run '^$' -bench BulkRewrite -benchtime 1x
func BenchmarkBulkRewrite(b *testing.B) {
	const files = 200
	data := []byte(strings.Repeat("a line of fiber body text\n", 80))
	cases := []struct {
		name  string
		write func(string, []byte, os.FileMode) error
	}{
		{"os.WriteFile", os.WriteFile},
		{"WriteUnsynced", WriteUnsynced},
		{"Write", Write},
	}
	for _, c := range cases {
		b.Run(c.name, func(b *testing.B) {
			dir := b.TempDir()
			paths := make([]string, files)
			for i := range paths {
				paths[i] = filepath.Join(dir, fmt.Sprintf("f%03d.md", i))
				if err := os.WriteFile(paths[i], data, 0o644); err != nil {
					b.Fatal(err)
				}
			}
			b.ResetTimer()
			for n := 0; n < b.N; n++ {
				for _, p := range paths {
					if err := c.write(p, data, 0o644); err != nil {
						b.Fatal(err)
					}
				}
			}
			b.ReportMetric(float64(b.Elapsed().Microseconds())/float64(b.N*files), "µs/file")
		})
	}
}
