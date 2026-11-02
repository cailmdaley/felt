package felt

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
)

// ChangeIndex caches native metadata for real directories and canonical fiber
// files. Symlink mounts belong to their physical store, not this view.
// The integers retain nanosecond timestamps across the daemon's JSON boundary.
type ChangeIndex map[string][4]int64

type ChangeScan struct {
	Index ChangeIndex `json:"index"`
	IDs   []string    `json:"ids"`
}

// ScanChanges checks known paths concurrently and enumerates only changed or
// new directories. Metadata is observed before enumeration: a concurrent writer
// changes the next pass's stamp rather than disappearing behind a new baseline.
// A failed observation leaves the caller's index untouched and retryable.
func ScanChanges(root string, previous ChangeIndex) (ChangeScan, error) {
	info, err := os.Lstat(root)
	if err != nil && !os.IsNotExist(err) {
		return ChangeScan{}, err
	}
	if os.IsNotExist(err) || !info.IsDir() {
		return removedChangeIndex(previous), nil
	}
	next := make(ChangeIndex, len(previous))
	changed := map[string]bool{}
	pending := make([]string, 0, len(previous)+1)
	pending = append(pending, ".")
	for rel := range previous {
		if rel != "." {
			if filepath.IsAbs(rel) || filepath.Clean(rel) != rel || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				return ChangeScan{}, fmt.Errorf("invalid index path %q", rel)
			}
			pending = append(pending, rel)
		}
	}
	seen := map[string]bool{}
	for len(pending) > 0 {
		paths := make([]string, 0, len(pending))
		for _, rel := range pending {
			if !seen[rel] {
				paths = append(paths, rel)
				seen[rel] = true
			}
		}
		pending = nil
		type observation struct {
			stamp   [4]int64
			entries []os.DirEntry
			missing bool
			err     error
		}
		results := make([]observation, len(paths))
		var wg sync.WaitGroup
		jobs := make(chan int)
		for worker := 0; worker < min(8, storageReadWorkers()); worker++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for i := range jobs {
					rel := paths[i]
					info, err := os.Lstat(filepath.Join(root, rel))
					if os.IsNotExist(err) || errors.Is(err, syscall.ENOTDIR) {
						results[i].missing = true
						continue
					}
					if err != nil {
						results[i].err = err
						continue
					}
					if !info.IsDir() && !info.Mode().IsRegular() {
						results[i].missing = true
						continue
					}
					stamp := [4]int64{info.ModTime().UnixNano(), info.Size(), int64(info.Mode()), int64(info.Sys().(*syscall.Stat_t).Ino)}
					results[i].stamp = stamp
					if old, ok := previous[rel]; info.IsDir() && (!ok || old != stamp) {
						results[i].entries, results[i].err = os.ReadDir(filepath.Join(root, rel))
					}
				}
			}()
		}
		for i := range paths {
			jobs <- i
		}
		close(jobs)
		wg.Wait()
		for i, rel := range paths {
			result := results[i]
			if result.err != nil {
				return ChangeScan{}, fmt.Errorf("scan %s: %w", filepath.Join(root, rel), result.err)
			}
			old, existed := previous[rel]
			if result.missing {
				if existed {
					if id, _, ok := fiberIDFromRelativePath(rel); ok && strings.HasSuffix(rel, FileExt) {
						changed[id] = true
					}
				}
				continue
			}
			next[rel] = result.stamp
			if !existed || old != result.stamp {
				if os.FileMode(result.stamp[2]).IsDir() {
					if rel != "." {
						changed[filepath.ToSlash(rel)] = true
					}
				} else if id, _, ok := fiberIDFromRelativePath(rel); ok {
					changed[id] = true
				}
			}
			for _, entry := range result.entries {
				if strings.HasPrefix(entry.Name(), ".") || entry.Type()&os.ModeSymlink != 0 {
					continue
				}
				child := filepath.Join(rel, entry.Name())
				if entry.IsDir() {
					pending = append(pending, child)
				} else if strings.HasSuffix(child, FileExt) {
					if _, _, ok := fiberIDFromRelativePath(child); ok {
						pending = append(pending, child)
					}
				}
			}
		}
	}
	// A missing directory or replacement symlink owns none of its cached
	// descendants. Drop them even if a simultaneous stat followed the new link.
	excluded := map[string]bool{}
	for rel, old := range previous {
		if current, ok := next[rel]; os.FileMode(old[2]).IsDir() && (!ok || !os.FileMode(current[2]).IsDir()) {
			excluded[rel] = true
		}
	}
	if current, ok := next["."]; !ok || !os.FileMode(current[2]).IsDir() {
		excluded["."] = true
	}
	for rel := range next {
		for parent := filepath.Dir(rel); ; parent = filepath.Dir(parent) {
			if excluded[parent] {
				delete(next, rel)
				if strings.HasSuffix(rel, FileExt) {
					if id, _, ok := fiberIDFromRelativePath(rel); ok {
						changed[id] = true
					}
				}
				break
			}
			if parent == "." {
				break
			}
		}
	}
	ids := make([]string, 0, len(changed))
	for id := range changed {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ChangeScan{Index: next, IDs: ids}, nil
}

func removedChangeIndex(previous ChangeIndex) ChangeScan {
	ids := []string{}
	for rel := range previous {
		if strings.HasSuffix(rel, FileExt) {
			if id, _, ok := fiberIDFromRelativePath(rel); ok {
				ids = append(ids, id)
			}
		}
	}
	sort.Strings(ids)
	return ChangeScan{Index: ChangeIndex{}, IDs: ids}
}
