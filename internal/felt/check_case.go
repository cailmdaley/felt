package felt

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// CheckCaseCollisions reports directories in the store that hold two entries
// whose names differ only by case — REPORT.md beside report.md, a fiber
// directory beside its capitalized twin. A case-insensitive filesystem (the
// macOS default) can hold only one of them, so a checkout there overwrites one
// with the other and git shows the file modified forever, blocking rebase and
// sync.
//
// It reads names from two places: the filesystem, where a case-sensitive host
// shows both twins, and the git index when the store is tracked, which is the
// only place a macOS checkout still sees both. Companion files count like
// fibers. Symlinked directories are not followed; each store they reach is
// checked on its own.
func CheckCaseCollisions(s *Storage) ([]CheckIssue, error) {
	root, err := filepath.EvalSymlinks(s.root)
	if err != nil {
		return nil, fmt.Errorf("resolving .felt path: %w", err)
	}
	paths, err := storeEntryPaths(root)
	if err != nil {
		return nil, err
	}
	paths = append(paths, gitIndexPaths(root)...)

	// Every prefix of every path is an entry in some directory. Group them by
	// lowercased full path; a group with two spellings is a collision.
	spellings := map[string]map[string]struct{}{}
	for _, p := range paths {
		parts := strings.Split(p, "/")
		for i := range parts {
			prefix := strings.Join(parts[:i+1], "/")
			key := strings.ToLower(prefix)
			if spellings[key] == nil {
				spellings[key] = map[string]struct{}{}
			}
			spellings[key][prefix] = struct{}{}
		}
	}

	var issues []CheckIssue
	for key, set := range spellings {
		if len(set) < 2 {
			continue
		}
		// A colliding directory makes everything under it collide as well;
		// report only the outermost pair.
		if parent := path.Dir(key); parent != "." && len(spellings[parent]) > 1 {
			continue
		}
		// The parent does not collide, so every spelling shares it.
		var dir string
		names := make([]string, 0, len(set))
		for p := range set {
			dir = path.Dir(p)
			names = append(names, path.Base(p))
		}
		sort.Strings(names)
		issues = append(issues, CheckIssue{
			Level:   CheckLevelError,
			FiberID: dir,
			Message: fmt.Sprintf("case collision: %s differ only by case; a case-insensitive filesystem (macOS) keeps one, so every checkout there shows the other modified — remove or rename one", strings.Join(quoteAll(names), " and ")),
		})
	}
	sortIssues(issues)
	return issues, nil
}

// storeEntryPaths lists every file and directory under root as a slash path
// relative to it, without following symlinks and skipping any .git directory.
func storeEntryPaths(root string) ([]string, error) {
	var paths []string
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == root {
			return nil
		}
		if d.IsDir() && d.Name() == ".git" {
			return filepath.SkipDir
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		paths = append(paths, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("walking store for case collisions: %w", err)
	}
	return paths, nil
}

// gitIndexPaths lists the tracked files under root, relative to it. A store
// outside any repository, or a missing git, yields nothing.
func gitIndexPaths(root string) []string {
	cmd := exec.Command("git", "-c", "core.quotePath=false", "ls-files", "-z")
	cmd.Dir = root
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	var paths []string
	for _, p := range bytes.Split(out, []byte{0}) {
		if len(p) > 0 {
			paths = append(paths, string(p))
		}
	}
	return paths
}

func quoteAll(names []string) []string {
	quoted := make([]string, len(names))
	for i, n := range names {
		quoted[i] = fmt.Sprintf("%q", n)
	}
	return quoted
}
