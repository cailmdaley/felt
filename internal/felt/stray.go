package felt

import (
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// StrayFiber is a fiber written outside the directory layout: a bare
// `<dir>/<slug>.md` below the store root, where the layout puts it at
// `<dir>/<slug>/<slug>.md`. It is not a fiber until it moves — listings and
// links do not see it, and a lookup that names it refuses rather than
// answering with some other fiber — so `felt check` reports it and
// `felt migrate` folds it into place.
//
// What separates a stray fiber from a companion file (a report, a
// transcript, notes kept beside a fiber) is fiber frontmatter: `name:` and at least
// one key only fibers carry (see strayMarkerKeys). Markdown without
// frontmatter, or with frontmatter that is not a fiber's — a SKILL.md's
// `name:` and `description:`, a report's `title:` and `date:` — is a
// companion and is left alone.
type StrayFiber struct {
	// ID is the fiber id the file takes once folded: `<dir>/<slug>`.
	ID string
	// Rel and TargetRel are the file's current and folded locations,
	// slash-separated and relative to `.felt/`.
	Rel       string
	TargetRel string
	// Blocked says why the file cannot be folded, and is empty when it can:
	// something already occupies its place, or the move would leave the
	// store or strand a symlink. A blocked stray is moved by hand.
	Blocked string

	path   string
	target string
}

// StrayFibers lists the store's stray fiber files, sorted by location.
func (s *Storage) StrayFibers() ([]StrayFiber, error) {
	_, loose, err := s.walkStore()
	if err != nil {
		return nil, err
	}
	return strayFibersIn(loose), nil
}

func strayFibersIn(loose []looseFile) []StrayFiber {
	// Where the store's loose symlinks point: folding a file one of them
	// names would leave that link dangling.
	linkedFrom := map[string]string{}
	for _, file := range loose {
		if !file.symlink {
			continue
		}
		if target, err := filepath.EvalSymlinks(file.path); err == nil {
			linkedFrom[target] = file.rel
		}
	}

	var strays []StrayFiber
	for _, file := range loose {
		if !hasFiberFrontmatter(file.path) {
			continue
		}
		id, slug := file.id(), path.Base(file.id())
		dir := filepath.Join(filepath.Dir(file.path), slug)
		sf := StrayFiber{
			ID:        id,
			Rel:       file.rel,
			TargetRel: path.Join(id, slug+FileExt),
			path:      file.path,
			target:    filepath.Join(dir, slug+FileExt),
		}
		sf.Blocked = foldBlocker(file, dir, sf.target)
		if resolved, err := filepath.EvalSymlinks(file.path); err == nil && sf.Blocked == "" {
			if link, ok := linkedFrom[resolved]; ok {
				sf.Blocked = fmt.Sprintf("the symlink .felt/%s points to it and would be left dangling", link)
			}
		}
		strays = append(strays, sf)
	}
	sort.Slice(strays, func(i, j int) bool { return strays[i].Rel < strays[j].Rel })
	return strays
}

// foldBlocker names what stops a loose file from moving to target inside
// dir, or returns "" when nothing does.
func foldBlocker(file looseFile, dir, target string) string {
	if file.symlink {
		return "it is a symlink; fold the file it points to instead"
	}
	if file.rel != "" {
		if parent, stem := path.Base(path.Dir(file.rel)), strings.TrimSuffix(path.Base(file.rel), FileExt); strings.EqualFold(parent, stem) {
			return fmt.Sprintf("its name differs from its directory's only in case; rename it to %s/%s%s", path.Dir(file.rel), parent, FileExt)
		}
	}
	if info, err := os.Lstat(dir); err == nil {
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			return "its directory would be a symlink, and folding would write through it into what it points to"
		case !info.IsDir():
			return "a file already sits where its directory would go"
		}
	}
	if _, err := os.Lstat(target); err == nil {
		return "slug collision with the fiber already there; merge the two by hand and delete the bare file"
	}
	return ""
}

// strayAt reports whether id names a stray fiber file, returning its location
// relative to `.felt/`. It is the per-id form of the walk's classification: a
// bare `<dir>/<slug>.md` below the root, outside hidden paths, not the
// entry point of a store mounted at `<dir>`, carrying fiber frontmatter.
func (s *Storage) strayAt(id string) (string, bool) {
	id = path.Clean(filepath.ToSlash(id))
	dir := path.Dir(id)
	if dir == "." || !validLookupID(id) || hiddenPath(id) {
		return "", false
	}
	parent := filepath.Join(s.root, filepath.FromSlash(dir))
	if info, err := os.Lstat(parent); err != nil || info.Mode()&os.ModeSymlink != 0 {
		return "", false
	}
	rel := id + FileExt
	if !hasFiberFrontmatter(filepath.Join(s.root, filepath.FromSlash(rel))) {
		return "", false
	}
	return rel, true
}

// id is the fiber id a loose file would have in directory form.
func (f looseFile) id() string {
	return strings.TrimSuffix(f.rel, FileExt)
}

// strayMarkerKeys are the frontmatter keys that mark a named file as a
// fiber: felt's native keys minus `description`, which skills and agent
// definitions share, plus the legacy `created`/`closed` spellings.
var strayMarkerKeys = []string{"id", "status", "tags", "outcome", "due", "created-at", "updated-at", "closed-at", "created", "closed"}

// hasFiberFrontmatter reports whether the file's frontmatter carries `name:`
// and at least one of strayMarkerKeys.
// readFrontmatterFile stops at the closing delimiter, so a large companion
// costs its frontmatter at most, and one line when it has none.
func hasFiberFrontmatter(filePath string) bool {
	frontmatter, err := readFrontmatterFile(filePath)
	if err != nil {
		return false
	}
	if !frontmatterHasTopLevelFields(frontmatter, []string{"name"}) {
		return false
	}
	for _, key := range strayMarkerKeys {
		if frontmatterHasTopLevelFields(frontmatter, []string{key}) {
			return true
		}
	}
	return false
}

// fold moves a stray fiber file into the directory layout. The id it gains is
// the one its path already spelled, so no reference needs rewriting. The
// blocking conditions are checked again at the moment of the move.
func (sf StrayFiber) fold() error {
	dir := filepath.Dir(sf.target)
	if blocker := foldBlocker(looseFile{}, dir, sf.target); blocker != "" {
		return fmt.Errorf("%s", blocker)
	}
	_, statErr := os.Stat(dir)
	created := os.IsNotExist(statErr)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("creating %s: %w", dir, err)
	}
	if err := os.Rename(sf.path, sf.target); err != nil {
		if created {
			_ = os.Remove(dir)
		}
		return fmt.Errorf("moving it: %w", err)
	}
	return nil
}

// checkStrayFibers reports each stray fiber file as a layout error.
func checkStrayFibers(strays []StrayFiber) []CheckIssue {
	issues := make([]CheckIssue, 0, len(strays))
	for _, sf := range strays {
		message := fmt.Sprintf("bare fiber file .felt/%s is outside the directory layout and invisible to felt; it belongs at .felt/%s — %s", sf.Rel, sf.TargetRel, LegacyFlatMigrationHint)
		if sf.Blocked != "" {
			message = fmt.Sprintf("bare fiber file .felt/%s is outside the directory layout and cannot be folded into .felt/%s: %s", sf.Rel, sf.TargetRel, sf.Blocked)
		}
		issues = append(issues, CheckIssue{
			Level:   CheckLevelError,
			FiberID: sf.ID,
			Message: message,
		})
	}
	return issues
}

// withStrayHint explains a failed lookup whose query names a stray fiber file:
// the file is right there on disk, and "not found" alone would read as a bug.
func withStrayHint(err error, query string, loose []looseFile) error {
	if errors.Is(err, ErrExternalReference) {
		return err
	}
	var named []looseFile
	for _, file := range loose {
		if id := file.id(); id == query || path.Base(id) == query {
			named = append(named, file)
		}
	}
	if strays := strayFibersIn(named); len(strays) > 0 {
		return strayHintError(err, strays[0].Rel)
	}
	return err
}

// strayHintError adds to err the stray fiber file behind it and the way out.
func strayHintError(err error, rel string) error {
	return &strayError{err: err, rel: rel}
}

type strayError struct {
	err error
	rel string // the stray file: relative to .felt/, or absolute when in another store
}

func (e *strayError) Error() string {
	return fmt.Sprintf("%v; %s holds fiber frontmatter but is outside the directory layout — %s", e.err, e.where(), LegacyFlatMigrationHint)
}

func (e *strayError) Unwrap() error { return e.err }

func (e *strayError) where() string {
	if filepath.IsAbs(e.rel) {
		return e.rel
	}
	return ".felt/" + e.rel
}

func isStrayError(err error) bool {
	var stray *strayError
	return errors.As(err, &stray)
}

// strayReason is the suffix a broken-reference issue carries when the
// reference names a stray fiber file, or "" when it does not.
func strayReason(err error) string {
	var stray *strayError
	if !errors.As(err, &stray) {
		return ""
	}
	return fmt.Sprintf(": %s is a stray fiber file — %s", stray.where(), LegacyFlatMigrationHint)
}
