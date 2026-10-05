package felt

import (
	"bytes"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// CheckCaseCollisions reports directories in the store that hold two entries
// whose names differ only by case — REPORT.md beside report.md, a fiber
// directory beside its capitalized twin. A case-insensitive filesystem (the
// macOS default) can hold only one of them, so a checkout there overwrites one
// with the other and git shows the file modified forever, blocking rebase and
// sync.
//
// Two sources are read, each on its own: the git index when the store is
// tracked, which is the only place a macOS checkout still sees both twins, and
// the filesystem, where a case-sensitive host shows both. A collision is two
// spellings within one source; a tracked file merely spelled differently on
// disk is one file, not two. Companion files count like fibers. Symlinked
// directories are not followed; each store they reach is checked on its own.
// git runs inside env.
func CheckCaseCollisions(env *sysenv.Env, s *Storage) ([]CheckIssue, error) {
	root, err := filepath.EvalSymlinks(s.root)
	if err != nil {
		return nil, fmt.Errorf("resolving .felt path: %w", err)
	}
	onDisk, err := storeEntryPaths(root)
	if err != nil {
		return nil, err
	}

	seen := map[string]bool{}
	var issues []CheckIssue
	for _, source := range [][]string{gitIndexPaths(env, root), onDisk} {
		for _, issue := range caseCollisions(source) {
			if key := issue.FiberID + "\x00" + issue.Message; !seen[key] {
				seen[key] = true
				issues = append(issues, issue)
			}
		}
	}
	sortIssues(issues)
	return issues, nil
}

// caseCollisions finds the entries of one listing of store-relative slash
// paths that differ only by case. Every prefix of every path is an entry in
// some directory; grouped by lowercased full path, a group with two spellings
// is a collision.
func caseCollisions(paths []string) []CheckIssue {
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
	return issues
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

// gitIndexPaths lists the tracked files under root, relative to it. It lists
// the whole index from the repository's top level and keeps the paths under
// root's prefix compared without case: on a case-insensitive filesystem the
// root may be reached through a spelling (a symlink's text, say) that differs
// from the one the index records, and git's own pathspec scoping would then
// find nothing. A store outside any repository, or a missing git, yields
// nothing.
func gitIndexPaths(env *sysenv.Env, root string) []string {
	topOut, err := gitOutput(env, root, "rev-parse", "--show-toplevel")
	if err != nil {
		return nil
	}
	// Only the newline is git's; a trailing space can belong to the name.
	top, err := filepath.EvalSymlinks(strings.TrimSuffix(string(topOut), "\n"))
	if err != nil {
		return nil
	}
	prefix, ok := foldedRel(top, root)
	if !ok {
		return nil
	}
	out, err := gitOutput(env, top, "-c", "core.quotePath=false", "ls-files", "-z")
	if err != nil {
		return nil
	}
	var paths []string
	for _, p := range bytes.Split(out, []byte{0}) {
		if len(p) > len(prefix) && strings.EqualFold(string(p[:len(prefix)]), prefix) {
			paths = append(paths, string(p[len(prefix):]))
		}
	}
	return paths
}

// foldedRel is root's slash path below top, with its segments matched without
// case, so a view that reaches the repository through a respelled ancestor
// still lands inside it. It ends in "/" unless root is top itself, and is not
// ok when root lies outside top.
func foldedRel(top, root string) (string, bool) {
	topParts := strings.Split(filepath.ToSlash(filepath.Clean(top)), "/")
	rootParts := strings.Split(filepath.ToSlash(filepath.Clean(root)), "/")
	if len(rootParts) < len(topParts) {
		return "", false
	}
	for i, part := range topParts {
		if !strings.EqualFold(part, rootParts[i]) {
			return "", false
		}
	}
	rest := rootParts[len(topParts):]
	if len(rest) == 0 {
		return "", true
	}
	return strings.Join(rest, "/") + "/", true
}

func gitOutput(env *sysenv.Env, dir string, args ...string) ([]byte, error) {
	cmd := env.Command("git", args...)
	cmd.Dir = dir
	return cmd.Output()
}

func quoteAll(names []string) []string {
	quoted := make([]string, len(names))
	for i, n := range names {
		quoted[i] = fmt.Sprintf("%q", n)
	}
	return quoted
}
