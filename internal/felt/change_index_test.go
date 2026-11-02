package felt

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestChangeIndexTracksCreationMoveEditAndDeletion(t *testing.T) {
	root := t.TempDir()
	write := func(rel, body string) {
		t.Helper()
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0644); err != nil {
			t.Fatal(err)
		}
	}
	scan := func(index ChangeIndex) ChangeScan {
		t.Helper()
		out, err := ScanChanges(root, index)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	write("plain/plain.md", "plain")
	first := scan(nil)
	if !reflect.DeepEqual(first.IDs, []string{"plain"}) {
		t.Fatal(first.IDs)
	}
	if out := scan(first.Index); len(out.IDs) != 0 {
		t.Fatal(out.IDs)
	}
	// Same-size edits in the same second require nanosecond timestamps.
	stamp := time.Unix(1800000000, 100)
	p := filepath.Join(root, "plain/plain.md")
	if err := os.Chtimes(p, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	baseline := scan(first.Index)
	write("plain/plain.md", "block")
	stamp = stamp.Add(time.Nanosecond)
	if err := os.Chtimes(p, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	edited := scan(baseline.Index)
	if !reflect.DeepEqual(edited.IDs, []string{"plain"}) {
		t.Fatal(edited.IDs)
	}
	write("new/new.md", "new")
	added := scan(edited.Index)
	if !reflect.DeepEqual(added.IDs, []string{"new"}) {
		t.Fatal(added.IDs)
	}
	if err := os.Rename(filepath.Join(root, "plain"), filepath.Join(root, "moved")); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(root, "moved/plain.md"), filepath.Join(root, "moved/moved.md")); err != nil {
		t.Fatal(err)
	}
	moved := scan(added.Index)
	if !reflect.DeepEqual(moved.IDs, []string{"moved", "plain"}) {
		t.Fatal(moved.IDs)
	}
	if err := os.RemoveAll(filepath.Join(root, "moved")); err != nil {
		t.Fatal(err)
	}
	deleted := scan(moved.Index)
	if !reflect.DeepEqual(deleted.IDs, []string{"moved"}) {
		t.Fatal(deleted.IDs)
	}
	// Companion creation refreshes the parent fiber's report projection.
	write("new/tapestry.html", "report")
	report := scan(deleted.Index)
	if !reflect.DeepEqual(report.IDs, []string{"new"}) {
		t.Fatal(report.IDs)
	}
}

func TestChangeIndexPhysicalOwnershipAndReplacement(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "external.md"), []byte("external"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "external")); err != nil {
		t.Fatal(err)
	}
	initial, err := ScanChanges(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(initial.IDs) != 0 {
		t.Fatal(initial.IDs)
	}
	file := filepath.Join(root, "root.md")
	if err := os.WriteFile(file, []byte("old"), 0644); err != nil {
		t.Fatal(err)
	}
	before, err := ScanChanges(root, initial.Index)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	replacement := filepath.Join(root, "replacement")
	if err := os.WriteFile(replacement, []byte("new"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(replacement, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, file); err != nil {
		t.Fatal(err)
	}
	after, err := ScanChanges(root, before.Index)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(after.IDs, []string{"root"}) {
		t.Fatal(after.IDs)
	}
	// The root turning into a mounted view must evict its physical ownership.
	moved := root + "-old"
	if err := os.Rename(root, moved); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(moved) })
	if err := os.Symlink(outside, root); err != nil {
		t.Fatal(err)
	}
	gone, err := ScanChanges(root, after.Index)
	if err != nil {
		t.Fatal(err)
	}
	if len(gone.Index) != 0 || !reflect.DeepEqual(gone.IDs, []string{"root"}) {
		t.Fatalf("%+v", gone)
	}
}

func TestChangeIndexPrunesDirectoryReplacedByMount(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	for _, base := range []string{root, outside} {
		if err := os.Mkdir(filepath.Join(base, "fiber"), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(base, "fiber/fiber.md"), []byte("content"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	before, err := ScanChanges(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(root, "fiber")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "fiber"), filepath.Join(root, "fiber")); err != nil {
		t.Fatal(err)
	}
	after, err := ScanChanges(root, before.Index)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(after.IDs, []string{"fiber"}) || len(after.Index) != 1 {
		t.Fatalf("%+v", after)
	}
	quiet, err := ScanChanges(root, after.Index)
	if err != nil {
		t.Fatal(err)
	}
	if len(quiet.IDs) != 0 || len(quiet.Index) != 1 {
		t.Fatalf("%+v", quiet)
	}
}

func TestChangeIndexPrunesDirectoryReplacedByFile(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "fiber")
	if err := os.Mkdir(path, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "fiber.md"), []byte("content"), 0644); err != nil {
		t.Fatal(err)
	}
	before, err := ScanChanges(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("replacement"), 0644); err != nil {
		t.Fatal(err)
	}
	after, err := ScanChanges(root, before.Index)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(after.IDs, []string{"fiber"}) {
		t.Fatal(after.IDs)
	}
	if _, ok := after.Index[filepath.Join("fiber", "fiber.md")]; ok {
		t.Fatal("retained child of regular file")
	}
}
