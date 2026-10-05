package felt

import (
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// ProjectRoot resolves a project root from an explicit directory. An empty
// directory searches upward from the current working directory; a non-empty
// directory must contain .felt directly.
func ProjectRoot(dir string) (string, error) {
	if dir == "" {
		return FindProjectRoot()
	}

	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", fmt.Errorf("resolving -C path: %w", err)
	}
	feltDir := filepath.Join(abs, DirName)
	if info, err := os.Stat(feltDir); err != nil || !info.IsDir() {
		return "", fmt.Errorf("no .felt directory in %s", abs)
	}
	return abs, nil
}

// RequireStore opens the store rooted at dir, or at the project containing the
// current working directory when dir is empty.
func RequireStore(dir string) (*Storage, string, error) {
	root, err := ProjectRoot(dir)
	if err != nil {
		return nil, "", fmt.Errorf("not in a felt repository")
	}
	return NewStorage(root), root, nil
}

// CommandScope returns the nearest fiber containing startDir, relative to
// root's .felt directory. An empty startDir uses the current working directory.
func CommandScope(root, startDir string) string {
	cwd := startDir
	if cwd == "" {
		var err error
		cwd, err = os.Getwd()
		if err != nil {
			return ""
		}
	} else if abs, err := filepath.Abs(startDir); err == nil {
		cwd = abs
	}

	feltRoot := filepath.Join(root, DirName)
	if resolved, err := filepath.EvalSymlinks(feltRoot); err == nil {
		feltRoot = resolved
	}
	if resolved, err := filepath.EvalSymlinks(cwd); err == nil {
		cwd = resolved
	}
	rel, err := filepath.Rel(feltRoot, cwd)
	if err != nil {
		return ""
	}
	rel = filepath.ToSlash(rel)
	if rel == "." || strings.HasPrefix(rel, "../") {
		return ""
	}

	parts := strings.Split(rel, "/")
	for i := len(parts); i > 0; i-- {
		candidate := path.Join(parts[:i]...)
		fiberPath := filepath.Join(feltRoot, filepath.FromSlash(candidate), path.Base(candidate)+FileExt)
		if info, err := os.Stat(fiberPath); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return ""
}

// Ref identifies a fiber and the store that contains it.
type Ref struct {
	Storage       *Storage
	ID            string
	Elsewhere     bool
	EnclosingRoot string
	// UID is the intrinsic UID the query resolved through, if it did.
	UID string
}

// Location formats the parenthetical that identifies the enclosing store for
// a fiber resolved outside the current view.
func (r Ref) Location() string {
	if !r.Elsewhere {
		return ""
	}
	return fmt.Sprintf(" (in %s)", r.EnclosingRoot)
}

var errNoFiberUID = errors.New("no fiber matches intrinsic UID")

// ResolveRef resolves a fiber query, reaching into the enclosing store when a
// project view cannot see the target. It prefers a matching intrinsic UID and
// returns the store that actually contains the fiber.
func ResolveRef(storage *Storage, scopeID, query string) (Ref, error) {
	return resolveRefWith(storage, scopeID, query, storage.FindMetadataInScope)
}

// ResolveExactRef resolves a fiber query for an operation that must not act on
// an inferred guess.
func ResolveExactRef(storage *Storage, scopeID, query string) (Ref, error) {
	return resolveRefWith(storage, scopeID, query, storage.FindMetadataWithoutGuessing)
}

func resolveRefWith(storage *Storage, scopeID, query string, find func(scopeID, query string) (*Felt, error)) (Ref, error) {
	if LooksLikeUID(query) {
		ref, err := resolveUIDRef(storage, query)
		if err == nil || !errors.Is(err, errNoFiberUID) {
			return ref, err
		}
	}
	f, err := find(scopeID, query)
	if err == nil {
		return Ref{Storage: storage, ID: f.ID}, nil
	}
	external, ok := AsExternalReference(err)
	if !ok {
		return Ref{}, err
	}
	outer := NewStorage(external.ProjectDir)
	outerFelt, outerErr := outer.FindMetadataInScope("", external.ID)
	if outerErr != nil {
		return Ref{}, err
	}
	return Ref{Storage: outer, ID: outerFelt.ID, Elsewhere: true, EnclosingRoot: external.Root}, nil
}

// ReadResolved resolves query and reads the fiber it names with read. A UID
// resolves to an id first, and the fiber can move before the read: when the
// fiber read there is missing or carries another UID, the UID is resolved and
// read once more.
func ReadResolved(storage *Storage, scopeID, query string, read func(Ref) (*Felt, error)) (Ref, *Felt, error) {
	ref, err := ResolveRef(storage, scopeID, query)
	if err != nil {
		return Ref{}, nil, err
	}
	f, err := read(ref)
	if ref.UID == "" || (err == nil && f.MatchesUID(ref.UID)) {
		return ref, f, err
	}
	if ref, err = ResolveRef(storage, scopeID, query); err != nil {
		return Ref{}, nil, err
	}
	f, err = read(ref)
	return ref, f, err
}

// resolveUIDRef searches the full enclosing namespace because intrinsic
// identities are global to that store, including fibers outside a project view.
// It refuses duplicate UIDs instead of choosing whichever path a walk sees first.
func resolveUIDRef(storage *Storage, uid string) (Ref, error) {
	search := storage
	root, prefix, enclosing := storage.EnclosingStore()
	if enclosing {
		external := storage.ExternalRefs()
		search = NewStorage(external.ProjectDir())
	}
	matches, err := search.ListMetadataByUID(uid)
	if err != nil {
		return Ref{}, fmt.Errorf("listing fibers for UID %q: %w", uid, err)
	}
	if len(matches) > 1 {
		ids := make([]string, len(matches))
		for i, f := range matches {
			ids[i] = f.ID
		}
		return Ref{}, fmt.Errorf("ambiguous fiber UID %q matches: %s", uid, strings.Join(ids, ", "))
	}
	if len(matches) == 0 {
		return Ref{}, fmt.Errorf("%w %q", errNoFiberUID, uid)
	}
	match := matches[0]
	if !enclosing {
		return Ref{Storage: search, ID: match.ID, UID: uid}, nil
	}
	if strings.HasPrefix(match.ID, prefix+"/") {
		return Ref{Storage: storage, ID: strings.TrimPrefix(match.ID, prefix+"/"), UID: uid}, nil
	}
	return Ref{Storage: search, ID: match.ID, Elsewhere: true, EnclosingRoot: root, UID: uid}, nil
}
