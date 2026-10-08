package felt

import (
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"path"
)

// TestWalkStoreMatchesSerialReference pins the exact serial DFS contract across
// nested fibers, loose files, report siblings, symlink tiers, hidden paths and
// enough independent directories to exercise the bounded read pool.
func TestWalkStoreMatchesSerialReference(t *testing.T) {
	t.Parallel()
	_, store := newStore(t)
	writeRawFiber(t, store.root, "alpha")
	writeRawFiber(t, store.root, "alpha/child")
	writeRawFiber(t, store.root, "beta/deep/leaf")
	writeRawFiber(t, store.root, "zeta")
	writeWalkFile(t, store.root, "entry.md")
	writeWalkFile(t, store.root, "alpha/notes.md")
	writeWalkFile(t, store.root, "alpha/report.html")
	writeWalkFile(t, store.root, "alpha/attachment.md")
	writeWalkFile(t, store.root, ".hidden/hidden.md")
	for i := range 48 {
		base := fmt.Sprintf("wide-%02d", i)
		writeRawFiber(t, store.root, base)
		writeRawFiber(t, store.root, base+"/middle/leaf")
		writeWalkFile(t, store.root, base+"/notes.md")
	}

	outer := t.TempDir()
	substore := NewStorage(outer)
	if err := substore.Init(); err != nil {
		t.Fatal(err)
	}
	writeWalkFile(t, substore.root, "guest.md") // the mounted entry-point fiber
	writeRawFiber(t, substore.root, "guest/nested")
	mounts := filepath.Join(store.root, "mounts")
	if err := os.MkdirAll(mounts, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(substore.root, filepath.Join(mounts, "guest")); err != nil {
		t.Fatal(err)
	}
	aliases := filepath.Join(store.root, "aliases")
	if err := os.MkdirAll(aliases, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(substore.root, filepath.Join(aliases, "first")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(substore.root, filepath.Join(aliases, "second")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(store.root, "missing-target"), filepath.Join(store.root, "broken")); err != nil {
		t.Fatal(err)
	}

	assertMatchesSerialReference(t, store)
}

// TestWalkStoreMatchesSerialReferenceRandomized varies tree shape with a
// fixed seed. Each sample includes enough sibling directories to overlap reads.
func TestWalkStoreMatchesSerialReferenceRandomized(t *testing.T) {
	t.Parallel()
	for seed := int64(0); seed < 50; seed++ {
		t.Run(fmt.Sprintf("seed-%02d", seed), func(t *testing.T) {
			t.Parallel()
			rng := rand.New(rand.NewSource(seed))
			_, store := newStore(t)
			for i := range 40 + rng.Intn(20) {
				id := fmt.Sprintf("root-%02d", i)
				depth := 1 + rng.Intn(4)
				for d := 0; d < depth; d++ {
					id += fmt.Sprintf("/branch-%02d", rng.Intn(4))
				}
				writeRawFiber(t, store.root, id)
				if rng.Intn(3) == 0 {
					writeWalkFile(t, store.root, filepath.ToSlash(filepath.Join(filepath.FromSlash(id), "note.md")))
				}
			}
			writeWalkFile(t, store.root, "root-entry.md")
			assertMatchesSerialReference(t, store)
		})
	}
}

func assertMatchesSerialReference(t *testing.T, store *Storage) {
	t.Helper()
	wantFiles, wantLoose, err := serialReferenceWalk(store)
	if err != nil {
		t.Fatalf("serial reference walk: %v", err)
	}
	gotFiles, gotLoose, err := store.walkStoreOnce()
	if err != nil {
		t.Fatalf("concurrent walk: %v", err)
	}
	if !reflect.DeepEqual(gotFiles, wantFiles) {
		t.Fatalf("fiber walk differs from serial DFS\n got: %#v\nwant: %#v", gotFiles, wantFiles)
	}
	if !reflect.DeepEqual(gotLoose, wantLoose) {
		t.Fatalf("loose-file walk differs from serial DFS\n got: %#v\nwant: %#v", gotLoose, wantLoose)
	}
}

func writeWalkFile(t *testing.T, root, rel string) {
	t.Helper()
	file := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(file), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("---\nname: fixture\n---\n"), 0644); err != nil {
		t.Fatal(err)
	}
}

// serialReferenceWalk is the pre-pool walkStoreOnce implementation from main.
// Keep this deliberately serial: it is the oracle for order and symlink-tier
// semantics, not a second invocation of the concurrent walker.
func serialReferenceWalk(s *Storage) ([]fiberFile, []looseFile, error) {
	rootResolved, err := filepath.EvalSymlinks(s.root)
	if err != nil {
		return nil, nil, fmt.Errorf("resolving .felt path: %w", err)
	}
	var files []fiberFile
	var loose []looseFile
	visited := map[string]struct{}{}
	var walkFn func(walkBase, idPrefix string) error
	var walkDirFn func(dir, walkBaseResolved, idPrefix string) error
	walkDirFn = func(dir, walkBaseResolved, idPrefix string) error {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		hasReportHTML := false
		for _, e := range entries {
			if !e.IsDir() && e.Name() == "report.html" {
				hasReportHTML = true
				break
			}
		}
		for _, d := range entries {
			fullPath := filepath.Join(dir, d.Name())
			if d.Type()&os.ModeSymlink != 0 {
				target, err := filepath.EvalSymlinks(fullPath)
				if err != nil {
					continue
				}
				info, err := os.Stat(target)
				if err != nil {
					continue
				}
				if info.IsDir() {
					inner, err := filepath.Rel(walkBaseResolved, fullPath)
					if err != nil {
						continue
					}
					if err := walkFn(target, path.Join(idPrefix, filepath.ToSlash(inner))); err != nil {
						return err
					}
					continue
				}
			}
			if d.IsDir() {
				if err := walkDirFn(fullPath, walkBaseResolved, idPrefix); err != nil {
					return err
				}
				continue
			}
			if !strings.HasSuffix(d.Name(), FileExt) {
				continue
			}
			rel, err := filepath.Rel(walkBaseResolved, fullPath)
			if err != nil {
				return err
			}
			id, entryPoint, ok := fiberIDFromRelativePath(rel)
			if !ok {
				if logical := path.Join(idPrefix, filepath.ToSlash(rel)); !hiddenPath(logical) {
					loose = append(loose, looseFile{path: fullPath, rel: logical, symlink: d.Type()&os.ModeSymlink != 0})
				}
				continue
			}
			if idPrefix != "" {
				id = path.Join(idPrefix, id)
				entryPoint = false
			}
			var reportPath string
			if hasReportHTML {
				reportPath = filepath.Join(dir, "report.html")
			}
			files = append(files, fiberFile{id: id, path: fullPath, entryPoint: entryPoint, reportPath: reportPath})
		}
		return nil
	}
	walkFn = func(walkBase, idPrefix string) error {
		walkBaseResolved, err := filepath.EvalSymlinks(walkBase)
		if err != nil {
			return nil
		}
		if _, seen := visited[walkBaseResolved]; seen {
			return nil
		}
		visited[walkBaseResolved] = struct{}{}
		return walkDirFn(walkBaseResolved, walkBaseResolved, idPrefix)
	}
	if err := walkFn(rootResolved, ""); err != nil {
		return nil, nil, fmt.Errorf("walking .felt directory: %w", err)
	}
	return files, loose, nil
}
