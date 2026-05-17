package felt

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"syscall"

	"gopkg.in/yaml.v3"
)

const (
	// DirName is the directory where felt files are stored.
	DirName = ".felt"
	// FileExt is the extension for felt files.
	FileExt = ".md"
	// MystConfigName is the MyST project file generated at init time.
	MystConfigName = "myst.yml"
)

const defaultMystConfig = `version: 1
project:
  title: Project Fibers
  error_rules:
    - rule: valid-page-frontmatter
      severity: ignore
site:
  template: article-theme
`

// Storage handles reading and writing felt files.
type Storage struct {
	root string // Path to .felt directory
}

type fiberFile struct {
	id         string
	path       string
	entryPoint bool // bare `.felt/<slug>.md` at the .felt/ root
}

type MigrationEntry struct {
	OldID string
	NewID string
}

type MigrationResult struct {
	Entries               []MigrationEntry
	TitleToNameIDs        []string
	RemovedDependsOnIDs   []string
	StrippedMystAnchorIDs []string
}

// NewStorage creates a storage instance for the given directory.
// The directory should be the project root (containing .felt/).
func NewStorage(projectRoot string) *Storage {
	return &Storage{
		root: filepath.Join(projectRoot, DirName),
	}
}

// ProjectRoot returns the project directory that owns this .felt store.
func (s *Storage) ProjectRoot() string {
	return filepath.Dir(s.root)
}

// Init creates the .felt directory if it doesn't exist.
func (s *Storage) Init() error {
	if err := os.MkdirAll(s.root, 0755); err != nil {
		return fmt.Errorf("creating .felt directory: %w", err)
	}
	mystPath := filepath.Join(s.root, MystConfigName)
	if _, err := os.Stat(mystPath); os.IsNotExist(err) {
		if err := os.WriteFile(mystPath, []byte(defaultMystConfig), 0644); err != nil {
			return fmt.Errorf("writing %s: %w", MystConfigName, err)
		}
	} else if err != nil {
		return fmt.Errorf("checking %s: %w", MystConfigName, err)
	}
	return nil
}

// Exists returns true if the .felt directory exists.
func (s *Storage) Exists() bool {
	info, err := os.Stat(s.root)
	return err == nil && info.IsDir()
}

// Path returns the full path for a felt file. Fibers can take one of two
// on-disk shapes:
//
//   - directory form  `<.felt>/<id>/<slug>.md`   (the standard layout)
//   - bare form       `<.felt>/<dir>/<slug>.md`  (no `<slug>/` nesting)
//
// The bare form occurs at namespace-root boundaries: the file sits directly
// inside a `.felt/` rather than in a `<slug>/` subdirectory. At depth zero
// it is the project-root fiber. At depth greater than zero it appears when
// another felt store is mounted via a symlinked subdirectory — its
// inner-root fiber surfaces in the outer namespace one tier deeper than the
// outer root.
//
// Path prefers the directory form for nested ids. Bare-form `.md` files at
// depth > 0 are usually sidecars (transcripts, notes adjacent to a real
// fiber) and don't carry frontmatter; preferring them would resolve to the
// wrong file. The bare fallback fires only when the directory form is
// missing, which is exactly the symlinked-substore case.
func (s *Storage) Path(id string) string {
	id = filepath.ToSlash(filepath.Clean(id))
	slug := path.Base(id)
	dir := path.Dir(id)
	dirForm := filepath.Join(s.root, filepath.FromSlash(id), slug+FileExt)
	if dir == "." {
		// Top-level: prefer the bare shape `.felt/<slug>.md` when it exists —
		// that's the project-root fiber's canonical layout when this store
		// is mounted into an outer one via a symlink at the parent level.
		// Falls back to the directory form for the standard nested layout.
		bare := filepath.Join(s.root, slug+FileExt)
		if _, err := os.Stat(bare); err == nil {
			return bare
		}
		return dirForm
	}
	// Nested ids: directory form first. The bare-at-parent shape only
	// appears at a symlink boundary into another store; fall through to it
	// when (and only when) the directory form doesn't resolve, so a
	// sidecar `.md` next to a directory-form fiber can't shadow the fiber.
	if _, err := os.Stat(dirForm); err == nil {
		return dirForm
	}
	bare := filepath.Join(s.root, filepath.FromSlash(dir), slug+FileExt)
	if _, err := os.Stat(bare); err == nil {
		return bare
	}
	return dirForm
}

// NextAvailableID returns the first unused ID based on a slug path.
func (s *Storage) NextAvailableID(baseID string) (string, error) {
	baseID = filepath.ToSlash(filepath.Clean(strings.TrimSpace(baseID)))
	baseID = strings.TrimPrefix(baseID, "./")
	if baseID == "." || baseID == "" {
		return "", fmt.Errorf("invalid felt id")
	}

	for n := 1; ; n++ {
		candidate := baseID
		if n > 1 {
			candidate = disambiguateID(baseID, n)
		}
		if _, err := os.Stat(s.Path(candidate)); err == nil {
			continue
		} else if !os.IsNotExist(err) {
			return "", fmt.Errorf("checking id %s: %w", candidate, err)
		}
		return candidate, nil
	}
}

// CheckAvailableID returns an error if the target fiber ID already exists.
func (s *Storage) CheckAvailableID(id string) error {
	id = filepath.ToSlash(filepath.Clean(strings.TrimSpace(id)))
	id = strings.TrimPrefix(id, "./")
	if id == "." || id == "" {
		return fmt.Errorf("invalid felt id")
	}
	if _, err := os.Stat(s.Path(id)); err == nil {
		return fmt.Errorf("fiber %q already exists", id)
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("checking existing fiber %q: %w", id, err)
	}
	return nil
}

// Write saves a felt to disk.
func (s *Storage) Write(f *Felt) error {
	if f == nil {
		return fmt.Errorf("cannot write nil felt")
	}
	data, err := f.Marshal()
	if err != nil {
		return err
	}

	path := s.Path(f.ID)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return fmt.Errorf("creating directory %s: %w", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		return fmt.Errorf("writing file %s: %w", path, err)
	}
	return nil
}

// Read loads a felt from disk by ID.
func (s *Storage) Read(id string) (*Felt, error) {
	return s.readWithMode(id, ParseFull)
}

// ReadMetadata loads just the felt metadata, skipping body parsing.
func (s *Storage) ReadMetadata(id string) (*Felt, error) {
	return s.readWithMode(id, ParseMetadataOnly)
}

// FindMetadata returns the first felt matching the ID prefix or basename,
// reading only metadata from the matching file.
func (s *Storage) FindMetadata(query string) (*Felt, error) {
	return s.FindMetadataInScope("", query)
}

// FindMetadataInScope returns the first felt matching the query using lexical
// scoped resolution rooted at scopeID.
func (s *Storage) FindMetadataInScope(scopeID, query string) (*Felt, error) {
	return s.findWithModeAndScope(scopeID, query, ParseMetadataOnly)
}

// FindExistingMetadataInScope resolves only direct on-disk candidates in the
// lexical scope chain. It intentionally does not fall back to walking the whole
// store, so narrow read paths can annotate exact refs without surprise work.
func (s *Storage) FindExistingMetadataInScope(scopeID, query string) (*Felt, bool, error) {
	return s.findExistingPathWithModeAndScope(scopeID, query, ParseMetadataOnly)
}

func (s *Storage) readWithMode(id string, mode ParseMode) (*Felt, error) {
	return s.readPathWithMode(s.Path(id), id, mode)
}

// readPathWithMode reads a fiber from a known on-disk path. Used by list-time
// callers that already discovered the file via the walk and shouldn't re-derive
// the path from the id (which loses information when ids cross symlink
// boundaries — e.g. an entry-point bare-form fiber inside a symlinked
// sub-store has no recoverable shape from the prefixed id alone).
func (s *Storage) readPathWithMode(path, id string, mode ParseMode) (*Felt, error) {
	if mode == ParseMetadataOnly {
		f, err := readMetadataFile(path, id)
		if err != nil {
			return nil, fmt.Errorf("reading file %s: %w", path, err)
		}
		return f, nil
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading file %s: %w", path, err)
	}
	return ParseWithMode(id, data, mode)
}

// Delete removes a felt from disk.
func (s *Storage) Delete(id string) error {
	path := s.Path(id)
	if err := os.Remove(path); err != nil {
		return fmt.Errorf("deleting file %s: %w", path, err)
	}
	for dir := filepath.Dir(path); dir != s.root; dir = filepath.Dir(dir) {
		err := os.Remove(dir)
		if err == nil {
			continue
		}
		if errors.Is(err, syscall.ENOTEMPTY) {
			break
		}
		return fmt.Errorf("cleaning directory %s: %w", dir, err)
	}
	return nil
}

// MoveSubtree moves a fiber and any nested descendants to a new path, rewriting
// data-flow references across the repository.
func (s *Storage) MoveSubtree(oldID, newID string) error {
	oldID = filepath.ToSlash(filepath.Clean(strings.TrimSpace(oldID)))
	newID = filepath.ToSlash(filepath.Clean(strings.TrimSpace(newID)))
	if oldID == "." || oldID == "" || newID == "." || newID == "" {
		return fmt.Errorf("invalid felt id")
	}
	if oldID == newID {
		return fmt.Errorf("source and destination are the same")
	}
	if strings.HasPrefix(newID, oldID+"/") {
		return fmt.Errorf("cannot move %s into its own subtree %s", oldID, newID)
	}
	if _, err := os.Stat(s.Path(newID)); err == nil {
		return fmt.Errorf("destination %s already exists", newID)
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("checking destination %s: %w", newID, err)
	}

	felts, err := s.List()
	if err != nil {
		return err
	}

	updated := make([]*Felt, 0, len(felts))
	movedAny := false
	for _, f := range felts {
		clone := *f
		if remappedID, ok := remapIDPrefix(clone.ID, oldID, newID); ok {
			clone.ID = remappedID
			movedAny = true
		}
		clone.RewriteDataFlowRefs(func(ref string) (string, bool) {
			return remapDataFlowRef(ref, oldID, newID)
		})
		updated = append(updated, &clone)
	}

	if !movedAny {
		return fmt.Errorf("no felt found at %s", oldID)
	}

	for _, f := range updated {
		if err := s.Write(f); err != nil {
			return err
		}
	}

	oldRoot := filepath.Join(s.root, filepath.FromSlash(oldID))
	if err := os.RemoveAll(oldRoot); err != nil {
		return fmt.Errorf("removing old subtree %s: %w", oldRoot, err)
	}
	for dir := filepath.Dir(oldRoot); dir != s.root; dir = filepath.Dir(dir) {
		err := os.Remove(dir)
		if err == nil {
			continue
		}
		if errors.Is(err, syscall.ENOTEMPTY) {
			break
		}
		return fmt.Errorf("cleaning directory %s: %w", dir, err)
	}

	return nil
}

// Migrate performs the storage-model normalization pass:
// flat-file fibers become directory fibers, legacy frontmatter `title` fields
// become `name`, and leading MyST anchor lines are stripped from bodies.
func (s *Storage) Migrate(dryRun bool) (*MigrationResult, error) {
	result, err := s.MigrateFlatFiles(dryRun)
	if err != nil {
		return nil, err
	}

	titleIDs, dependsOnIDs, anchorIDs, err := s.NormalizeFiberFiles(dryRun)
	if err != nil {
		return nil, err
	}
	result.TitleToNameIDs = titleIDs
	result.RemovedDependsOnIDs = dependsOnIDs
	result.StrippedMystAnchorIDs = anchorIDs
	return result, nil
}

// MigrateFlatFiles converts legacy top-level flat markdown fibers to
// directory-based fibers with slug IDs, rewriting data-flow references.
func (s *Storage) MigrateFlatFiles(dryRun bool) (*MigrationResult, error) {
	if err := s.Init(); err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(s.root)
	if err != nil {
		return nil, fmt.Errorf("reading .felt directory: %w", err)
	}

	type legacyFiber struct {
		oldID string
		path  string
		felt  *Felt
	}

	var legacy []legacyFiber
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if name == MystConfigName || filepath.Ext(name) != FileExt {
			continue
		}
		oldID := strings.TrimSuffix(name, FileExt)
		data, err := os.ReadFile(filepath.Join(s.root, name))
		if err != nil {
			return nil, fmt.Errorf("reading legacy fiber %s: %w", name, err)
		}
		f, err := Parse(oldID, data)
		if err != nil {
			return nil, fmt.Errorf("parsing legacy fiber %s: %w", name, err)
		}
		legacy = append(legacy, legacyFiber{
			oldID: oldID,
			path:  filepath.Join(s.root, name),
			felt:  f,
		})
	}

	// A single bare .md at .felt/ root is the entry-point fiber, not legacy —
	// preserve it. Multiple bare files are orphaned flat-format fibers needing
	// a home, so migrate them to <slug>/<slug>.md form.
	if len(legacy) == 1 {
		return &MigrationResult{}, nil
	}

	result := &MigrationResult{Entries: make([]MigrationEntry, 0, len(legacy))}
	if len(legacy) == 0 {
		return result, nil
	}

	used := map[string]struct{}{}
	for _, f := range legacy {
		baseID, err := GenerateID(f.felt.DisplayName())
		if err != nil {
			return nil, fmt.Errorf("generate slug for %s: %w", f.oldID, err)
		}
		newID, err := s.nextAvailableMigrationID(baseID, used)
		if err != nil {
			return nil, err
		}
		used[newID] = struct{}{}
		result.Entries = append(result.Entries, MigrationEntry{
			OldID: f.oldID,
			NewID: newID,
		})
	}

	slices.SortFunc(result.Entries, func(a, b MigrationEntry) int {
		return strings.Compare(a.OldID, b.OldID)
	})

	if dryRun {
		return result, nil
	}

	idMap := map[string]string{}
	for _, entry := range result.Entries {
		idMap[entry.OldID] = entry.NewID
	}

	for _, item := range legacy {
		f := item.felt
		f.ID = idMap[item.oldID]
		f.RewriteDataFlowRefs(func(ref string) (string, bool) {
			if remappedFrom, ok := remapDataFlowRef(ref, item.oldID, f.ID); ok {
				return remappedFrom, true
			}
			targetFiber, fragment := splitDataFlowRef(ref)
			newTargetID, ok := idMap[targetFiber]
			if !ok {
				return "", false
			}
			if fragment == "" {
				return newTargetID, true
			}
			return newTargetID + "." + fragment, true
		})
		if err := s.Write(f); err != nil {
			return nil, err
		}
	}

	for _, item := range legacy {
		if err := os.Remove(item.path); err != nil {
			return nil, fmt.Errorf("removing legacy fiber %s: %w", item.path, err)
		}
	}

	// Rewrite stale hex-suffixed data-flow refs in pre-existing directory fibers.
	allFibers, err := s.List()
	if err != nil {
		return nil, fmt.Errorf("listing fibers for input rewrite: %w", err)
	}
	for _, f := range allFibers {
		changed := f.RewriteDataFlowRefs(func(ref string) (string, bool) {
			targetFiber, fragment := splitDataFlowRef(ref)
			newID, ok := idMap[targetFiber]
			if !ok {
				return "", false
			}
			if fragment == "" {
				return newID, true
			}
			return newID + "." + fragment, true
		})
		if changed {
			if err := s.Write(f); err != nil {
				return nil, fmt.Errorf("rewriting inputs in %s: %w", f.ID, err)
			}
		}
	}

	return result, nil
}

// NormalizeFiberFiles rewrites legacy per-file format details in-place:
// frontmatter `title` -> `name`, and leading MyST anchor lines in bodies.
func (s *Storage) NormalizeFiberFiles(dryRun bool) ([]string, []string, []string, error) {
	files, err := s.listFiberFiles()
	if err != nil {
		return nil, nil, nil, err
	}

	var titleIDs []string
	var dependsOnIDs []string
	var anchorIDs []string
	for _, file := range files {
		data, err := os.ReadFile(file.path)
		if err != nil {
			return nil, nil, nil, fmt.Errorf("reading fiber %s: %w", file.path, err)
		}

		rewritten, renamedTitle, removedDependsOn, strippedAnchor, changed, err := normalizeFiberFile(file.id, data)
		if err != nil {
			return nil, nil, nil, fmt.Errorf("normalize fiber %s: %w", file.path, err)
		}
		if !changed {
			continue
		}
		if renamedTitle {
			titleIDs = append(titleIDs, file.id)
		}
		if removedDependsOn {
			dependsOnIDs = append(dependsOnIDs, file.id)
		}
		if strippedAnchor {
			anchorIDs = append(anchorIDs, file.id)
		}
		if dryRun {
			continue
		}
		if err := os.WriteFile(file.path, rewritten, 0644); err != nil {
			return nil, nil, nil, fmt.Errorf("writing normalized fiber %s: %w", file.path, err)
		}
	}

	slices.Sort(titleIDs)
	slices.Sort(dependsOnIDs)
	slices.Sort(anchorIDs)
	return titleIDs, dependsOnIDs, anchorIDs, nil
}

func normalizeFiberFile(id string, content []byte) ([]byte, bool, bool, bool, bool, error) {
	frontmatter, body, err := splitFrontmatter(content, true)
	if err != nil {
		return nil, false, false, false, false, err
	}

	rewrittenFrontmatter, renamedTitle, removedDependsOn, err := normalizeLegacyFrontmatter(frontmatter)
	if err != nil {
		return nil, false, false, false, false, err
	}
	rewrittenBody, strippedAnchor := stripLegacyMystAnchor(id, body)
	changed := renamedTitle || removedDependsOn || strippedAnchor
	if !changed {
		return content, false, false, false, false, nil
	}

	var out bytes.Buffer
	out.WriteString("---\n")
	out.Write(rewrittenFrontmatter)
	out.WriteString("---\n")
	if rewrittenBody != "" {
		out.WriteString("\n")
		out.WriteString(rewrittenBody)
		if !strings.HasSuffix(rewrittenBody, "\n") {
			out.WriteString("\n")
		}
	}
	return out.Bytes(), renamedTitle, removedDependsOn, strippedAnchor, true, nil
}

// List returns all felts in the storage.
func (s *Storage) List() ([]*Felt, error) {
	return s.listWithMode(ParseFull, false)
}

// ListMetadata returns all felts with frontmatter only.
func (s *Storage) ListMetadata() ([]*Felt, error) {
	return s.listWithMode(ParseMetadataOnly, false)
}

// ListMetadataHavingFrontmatterFields returns metadata for fibers whose raw
// frontmatter contains all requested top-level keys. It is a narrow listing
// path for machine consumers that need only one tool-owned namespace (for
// example, every fiber with a `shuttle:` block) and should not pay a full YAML
// parse for unrelated fibers.
func (s *Storage) ListMetadataHavingFrontmatterFields(fields []string) ([]*Felt, error) {
	return s.listWithModeHavingFrontmatterFields(ParseMetadataOnly, false, fields)
}

// ListMetadataWithModTime returns metadata plus file modification times.
func (s *Storage) ListMetadataWithModTime() ([]*Felt, error) {
	return s.listWithMode(ParseMetadataOnly, true)
}

// ListMetadataWithModTimeHavingFrontmatterFields returns metadata plus file
// modification times for fibers whose raw frontmatter contains all requested
// top-level keys.
func (s *Storage) ListMetadataWithModTimeHavingFrontmatterFields(fields []string) ([]*Felt, error) {
	return s.listWithModeHavingFrontmatterFields(ParseMetadataOnly, true, fields)
}

func (s *Storage) listWithMode(mode ParseMode, includeModTime bool) ([]*Felt, error) {
	return s.listWithModeHavingFrontmatterFields(mode, includeModTime, nil)
}

func (s *Storage) listWithModeHavingFrontmatterFields(mode ParseMode, includeModTime bool, fields []string) ([]*Felt, error) {
	files, err := s.listFiberFiles()
	if err != nil {
		return nil, err
	}

	var felts []*Felt
	for _, file := range files {
		var f *Felt
		if len(fields) > 0 && mode == ParseMetadataOnly {
			matched, err := fileFrontmatterHasTopLevelFields(file.path, fields)
			if err != nil {
				fmt.Fprintf(os.Stderr, "warning: failed to parse %s: %v\n", file.path, err)
				continue
			}
			if !matched {
				continue
			}
			f, err = s.readPathWithMode(file.path, file.id, mode)
			if err != nil {
				fmt.Fprintf(os.Stderr, "warning: failed to parse %s: %v\n", file.path, err)
				continue
			}
		} else {
			var err error
			f, err = s.readPathWithMode(file.path, file.id, mode)
			if err != nil {
				fmt.Fprintf(os.Stderr, "warning: failed to parse %s: %v\n", file.path, err)
				continue
			}
		}
		if includeModTime {
			if info, err := os.Stat(file.path); err == nil {
				f.ModifiedAt = info.ModTime()
			}
		}
		f.EntryPoint = file.entryPoint
		felts = append(felts, f)
	}

	return felts, nil
}

// Find returns the first felt matching the ID prefix or basename.
func (s *Storage) Find(query string) (*Felt, error) {
	return s.FindInScope("", query)
}

// FindInScope returns the first felt matching the query using lexical scoped
// resolution rooted at scopeID.
func (s *Storage) FindInScope(scopeID, query string) (*Felt, error) {
	return s.findWithModeAndScope(scopeID, query, ParseFull)
}

func (s *Storage) findWithMode(query string, mode ParseMode) (*Felt, error) {
	return s.findWithModeAndScope("", query, mode)
}

func (s *Storage) findWithModeAndScope(scopeID, query string, mode ParseMode) (*Felt, error) {
	if f, ok, err := s.findExistingPathWithModeAndScope(scopeID, query, mode); ok || err != nil {
		return f, err
	}

	files, err := s.listFiberFiles()
	if err != nil {
		return nil, err
	}

	query = cleanLookupQuery(query)
	scopeID = cleanLookupScope(scopeID)

	pathByID := make(map[string]string, len(files))
	ids := make([]string, 0, len(files))
	for _, file := range files {
		pathByID[file.id] = file.path
		ids = append(ids, file.id)
	}

	matchID, err := ResolveScopedID(ids, scopeID, query)
	if err != nil {
		return nil, err
	}
	f, err := s.readPathWithMode(pathByID[matchID], matchID, mode)
	if err != nil {
		return nil, err
	}
	if info, err := os.Stat(pathByID[matchID]); err == nil {
		f.ModifiedAt = info.ModTime()
	}
	return f, nil
}

func (s *Storage) findExistingPathWithModeAndScope(scopeID, query string, mode ParseMode) (*Felt, bool, error) {
	query = cleanLookupQuery(query)
	if query == "" || !validLookupID(query) {
		return nil, false, nil
	}
	scopeID = cleanLookupScope(scopeID)
	if scopeID != "" && !validLookupID(scopeID) {
		return nil, false, nil
	}

	var candidates []string
	if strings.Contains(query, "/") {
		candidates = []string{query}
	}
	for _, scope := range scopeChain(scopeID) {
		candidates = append(candidates, scopedQuery(scope, query))
	}

	seen := make(map[string]struct{}, len(candidates))
	for _, candidate := range candidates {
		candidate = path.Clean(candidate)
		if _, ok := seen[candidate]; ok {
			continue
		}
		seen[candidate] = struct{}{}

		f, ok, err := s.readExistingPathWithMode(candidate, mode)
		if ok || err != nil {
			return f, ok, err
		}
	}
	return nil, false, nil
}

func validLookupID(id string) bool {
	return id != ".." && !strings.HasPrefix(id, "../") && !path.IsAbs(id)
}

func (s *Storage) readExistingPathWithMode(id string, mode ParseMode) (*Felt, bool, error) {
	filePath := s.Path(id)
	if !s.pathInStore(filePath) {
		return nil, false, nil
	}
	info, err := os.Stat(filePath)
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("checking file %s: %w", filePath, err)
	}
	if info.IsDir() {
		return nil, false, nil
	}

	f, err := s.readPathWithMode(filePath, id, mode)
	if err != nil {
		return nil, true, err
	}
	f.ModifiedAt = info.ModTime()
	return f, true, nil
}

func (s *Storage) pathInStore(filePath string) bool {
	root := filepath.Clean(s.root)
	filePath = filepath.Clean(filePath)
	rel, err := filepath.Rel(root, filePath)
	return err == nil && rel != "." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && rel != ".."
}

func (s *Storage) listFiberFiles() ([]fiberFile, error) {
	// Resolve symlinks on the root so WalkDir descends into symlinked .felt/ dirs.
	rootResolved, err := filepath.EvalSymlinks(s.root)
	if err != nil {
		return nil, fmt.Errorf("resolving .felt path: %w", err)
	}
	var files []fiberFile
	visited := map[string]struct{}{}

	// walkFn walks one tier of the felt tree, recursing through any symlinked
	// subdirectory. `walkBase` is the absolute, symlinks-resolved root of this
	// tier; ids are computed relative to it so they stay clean even when the
	// symlink target lives outside `rootResolved` — the case where a
	// subdirectory of this store is a symlink into a foreign `.felt/`
	// elsewhere on disk (a "mounted" sub-store).
	//
	// `idPrefix` carries the symlink's logical position in the outer tree
	// (e.g. `projects/foo/`), and is prepended to inner-relative ids so
	// they surface in the outer namespace as `projects/foo/<inner>` instead
	// of leaking the resolved absolute path through filepath.Rel as
	// `../../<somewhere>/...`. The convention matches how regular
	// directories work: the path you place a symlink at *is* its name in
	// the outer namespace.
	var walkFn func(walkBase, idPrefix string) error
	walkFn = func(walkBase, idPrefix string) error {
		walkBaseResolved, err := filepath.EvalSymlinks(walkBase)
		if err != nil {
			return nil // skip unresolvable roots
		}
		if _, seen := visited[walkBaseResolved]; seen {
			return nil
		}
		visited[walkBaseResolved] = struct{}{}
		return filepath.WalkDir(walkBaseResolved, func(fullPath string, d fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			// Symlinked subdirectory: capture its logical position relative to
			// walkBaseResolved before resolving, so the recursive walk lifts
			// every inner id back into the outer namespace.
			if d.Type()&os.ModeSymlink != 0 {
				target, err := filepath.EvalSymlinks(fullPath)
				if err != nil {
					return nil // skip broken symlinks
				}
				info, err := os.Stat(target)
				if err != nil {
					return nil
				}
				if info.IsDir() {
					inner, err := filepath.Rel(walkBaseResolved, fullPath)
					if err != nil {
						return nil
					}
					nextPrefix := path.Join(idPrefix, filepath.ToSlash(inner))
					return walkFn(target, nextPrefix)
				}
			}
			if d.IsDir() || !strings.HasSuffix(d.Name(), FileExt) {
				return nil
			}
			// Compute rel within this tier (clean inner namespace), then prepend
			// the accumulated outer prefix to lift the id back into the parent
			// tree. Resolved-then-fullPath fallback preserves the prior
			// best-effort behaviour for pathological symlinks.
			resolved, err := filepath.EvalSymlinks(fullPath)
			if err != nil {
				resolved = fullPath
			}
			rel, err := filepath.Rel(walkBaseResolved, resolved)
			if err != nil {
				rel, err = filepath.Rel(walkBaseResolved, fullPath)
				if err != nil {
					return err
				}
			}
			id, entryPoint, ok := fiberIDFromRelativePath(rel)
			if !ok {
				return nil
			}
			if idPrefix != "" {
				id = path.Join(idPrefix, id)
				// Crossing a symlink into a sub-store means this file is never
				// the *outer* entry-point fiber — the entry-point shape only
				// applies at the root the user is asking about.
				entryPoint = false
			}
			files = append(files, fiberFile{id: id, path: fullPath, entryPoint: entryPoint})
			return nil
		})
	}
	if err := walkFn(rootResolved, ""); err != nil {
		return nil, fmt.Errorf("walking .felt directory: %w", err)
	}
	return files, nil
}

// fiberIDFromRelativePath returns (id, entryPoint, ok). entryPoint is true
// when the file is a bare `<slug>.md` at the `.felt/` root — the shape the
// project-level root fiber takes.
func fiberIDFromRelativePath(rel string) (string, bool, bool) {
	rel = filepath.Clean(rel)
	dir := filepath.Dir(rel)
	base := strings.TrimSuffix(filepath.Base(rel), FileExt)
	if dir == "." {
		return base, true, true
	}
	if filepath.Base(dir) != base {
		return "", false, false
	}
	return filepath.ToSlash(dir), false, true
}

func disambiguateID(id string, n int) string {
	id = filepath.ToSlash(id)
	dir := path.Dir(id)
	base := path.Base(id)
	candidate := fmt.Sprintf("%s-%d", base, n)
	if dir == "." {
		return candidate
	}
	return path.Join(dir, candidate)
}

// ResolveAddPath disambiguates a new fiber's slug-path against the existing
// tree. When the leading segment of slug matches the basename of an existing
// fiber, the slug is rewritten so the new fiber lands under that fiber's
// parent — preventing silent top-level creation when the user meant to nest
// below a fiber that already lives deep in the tree.
//
// Resolution rules:
//   - Single-segment slugs (no `/`) are never resolved; top-level creation is
//     unambiguous in intent.
//   - If no existing fiber has a basename equal to the leading segment, the
//     slug is returned unchanged.
//   - If exactly one existing fiber matches, the new path is `<parent>/<slug>`,
//     and rewritten is true so the caller can inform the user.
//   - If the slug already corresponds to one of the candidate placements
//     (typically because the user passed a fully-qualified path), it's
//     returned as-is with rewritten=false — fully-qualified callers get no
//     surprise rewrite and no info chatter.
//   - If multiple candidates resolve to distinct paths, the function returns
//     an ambiguity error listing each candidate path; the caller must
//     fully-qualify the slug or opt into top-level placement.
func ResolveAddPath(slug string, existingIDs []string) (resolved string, rewritten bool, err error) {
	slug = path.Clean(strings.TrimSpace(slug))
	if slug == "" || slug == "." {
		return slug, false, nil
	}
	if !strings.Contains(slug, "/") {
		return slug, false, nil
	}
	leading := slug[:strings.Index(slug, "/")]

	// Candidate parents: each existing fiber whose basename matches the
	// leading segment contributes its parent directory. Parents are
	// deduplicated because two fibers can't share the same id, but two
	// fibers can share a basename in different subtrees.
	type candidate struct {
		parent   string
		resolved string
	}
	var candidates []candidate
	seenParents := map[string]struct{}{}
	for _, id := range existingIDs {
		if path.Base(id) != leading {
			continue
		}
		parent := path.Dir(id)
		if parent == "." {
			parent = ""
		}
		if _, ok := seenParents[parent]; ok {
			continue
		}
		seenParents[parent] = struct{}{}
		var resolvedPath string
		if parent == "" {
			resolvedPath = slug
		} else {
			resolvedPath = parent + "/" + slug
		}
		candidates = append(candidates, candidate{parent: parent, resolved: resolvedPath})
	}

	if len(candidates) == 0 {
		return slug, false, nil
	}

	// If the user's input already matches one of the candidate placements
	// (e.g. they passed a fully-qualified path or top-level was the right
	// answer), use it as-is — no rewrite, no info chatter.
	for _, c := range candidates {
		if c.resolved == slug {
			return slug, false, nil
		}
	}

	if len(candidates) == 1 {
		return candidates[0].resolved, true, nil
	}

	// Ambiguous: stable-sorted candidate list for a deterministic error.
	paths := make([]string, len(candidates))
	for i, c := range candidates {
		paths[i] = c.resolved
	}
	sort.Strings(paths)
	return "", false, fmt.Errorf(
		"%q could resolve to multiple existing locations:\n  %s\npass a fully-qualified path or --top-level to disambiguate",
		slug,
		strings.Join(paths, "\n  "),
	)
}

// FindByPrefix finds a fiber matching a query in an existing slice.
// Use this instead of Find when you already have the list from List().
func FindByPrefix(felts []*Felt, query string) (*Felt, error) {
	return FindByScope(felts, "", query)
}

// FindByScope finds a fiber matching a query inside a lexical scope from an
// existing slice.
func FindByScope(felts []*Felt, scopeID, query string) (*Felt, error) {
	byID := make(map[string]*Felt, len(felts))
	ids := make([]string, 0, len(felts))
	for _, f := range felts {
		byID[f.ID] = f
		ids = append(ids, f.ID)
	}

	id, err := ResolveScopedID(ids, scopeID, query)
	if err != nil {
		return nil, err
	}
	return byID[id], nil
}

// ResolveScopedID resolves query by walking up from scopeID like lexical scope.
func ResolveScopedID(ids []string, scopeID, query string) (string, error) {
	return newScopedIDResolver(ids).Resolve(scopeID, query)
}

type scopedIDResolver struct {
	ids          []string
	exact        map[string]struct{}
	parentBases  map[string]map[string]string
	parentSorted map[string][]scopedIDEntry
}

type scopedIDEntry struct {
	base string
	id   string
}

func newScopedIDResolver(ids []string) *scopedIDResolver {
	resolver := &scopedIDResolver{
		ids:          make([]string, 0, len(ids)),
		exact:        make(map[string]struct{}, len(ids)),
		parentBases:  map[string]map[string]string{},
		parentSorted: map[string][]scopedIDEntry{},
	}
	for _, id := range ids {
		cleanID := path.Clean(id)
		resolver.ids = append(resolver.ids, cleanID)
		resolver.exact[cleanID] = struct{}{}

		parent := parentPath(cleanID)
		base := path.Base(cleanID)
		if resolver.parentBases[parent] == nil {
			resolver.parentBases[parent] = map[string]string{}
		}
		resolver.parentBases[parent][base] = cleanID
		resolver.parentSorted[parent] = append(resolver.parentSorted[parent], scopedIDEntry{base: base, id: cleanID})
	}
	sort.Strings(resolver.ids)
	for parent, entries := range resolver.parentSorted {
		sort.Slice(entries, func(i, j int) bool {
			if entries[i].base != entries[j].base {
				return entries[i].base < entries[j].base
			}
			return entries[i].id < entries[j].id
		})
		resolver.parentSorted[parent] = entries
	}
	return resolver
}

func (r *scopedIDResolver) Resolve(scopeID, query string) (string, error) {
	id, ok, resolutionErr := r.resolve(scopeID, query)
	if ok {
		return id, nil
	}
	return "", resolutionErr
}

func (r *scopedIDResolver) ResolveOK(scopeID, query string) (string, bool) {
	id, ok, _ := r.resolve(scopeID, query)
	return id, ok
}

func (r *scopedIDResolver) resolve(scopeID, query string) (string, bool, error) {
	query = cleanLookupQuery(query)
	scopeID = cleanLookupScope(scopeID)
	if query == "" {
		return "", false, fmt.Errorf("no felt found matching %q", query)
	}

	if _, ok := r.exact[query]; ok {
		return query, true, nil
	}

	if strings.Contains(query, "/") {
		for _, scope := range scopeChain(scopeID) {
			candidate := scopedQuery(scope, query)
			matches := r.prefixMatches(candidate)
			switch len(matches) {
			case 0:
				continue
			case 1:
				return matches[0], true, nil
			default:
				return "", false, fmt.Errorf("ambiguous ID %q in scope %q matches: %s", query, displayScope(scope), strings.Join(matches, ", "))
			}
		}
		return "", false, fmt.Errorf("no felt found matching %q", query)
	}

	for _, scope := range scopeChain(scopeID) {
		// Exact basename match takes priority over prefix matches.
		if exact, ok := r.exactBasenameMatch(scope, query); ok {
			return exact, true, nil
		}
		matches := r.basenamePrefixMatches(scope, query)
		switch len(matches) {
		case 0:
			continue
		case 1:
			return matches[0], true, nil
		default:
			return "", false, fmt.Errorf("ambiguous ID %q in scope %q matches: %s", query, displayScope(scope), strings.Join(matches, ", "))
		}
	}

	return "", false, fmt.Errorf("no felt found matching %q", query)
}

func (r *scopedIDResolver) prefixMatches(candidate string) []string {
	start := sort.SearchStrings(r.ids, candidate)
	var matches []string
	for _, id := range r.ids[start:] {
		if id != candidate && !strings.HasPrefix(id, candidate) {
			break
		}
		matches = append(matches, id)
	}
	return matches
}

func (r *scopedIDResolver) exactBasenameMatch(scopeID, query string) (string, bool) {
	byBase := r.parentBases[scopeID]
	if byBase == nil {
		return "", false
	}
	id, ok := byBase[query]
	return id, ok
}

func (r *scopedIDResolver) basenamePrefixMatches(scopeID, query string) []string {
	entries := r.parentSorted[scopeID]
	start := sort.Search(len(entries), func(i int) bool {
		return entries[i].base >= query
	})
	var matches []string
	for _, entry := range entries[start:] {
		if !strings.HasPrefix(entry.base, query) {
			break
		}
		matches = append(matches, entry.id)
	}
	return matches
}

func cleanLookupQuery(query string) string {
	query = strings.TrimSpace(query)
	if query == "" {
		return ""
	}
	query = path.Clean(query)
	if query == "." {
		return ""
	}
	return strings.TrimPrefix(query, "./")
}

func cleanLookupScope(scopeID string) string {
	scopeID = strings.TrimSpace(scopeID)
	if scopeID == "" {
		return ""
	}
	scopeID = path.Clean(scopeID)
	if scopeID == "." {
		return ""
	}
	return scopeID
}

func scopeChain(scopeID string) []string {
	scopeID = cleanLookupScope(scopeID)
	if scopeID == "" {
		return []string{""}
	}
	var scopes []string
	for {
		scopes = append(scopes, scopeID)
		parent := parentPath(scopeID)
		if parent == "" {
			break
		}
		scopeID = parent
	}
	return append(scopes, "")
}

func scopedQuery(scopeID, query string) string {
	if scopeID == "" {
		return query
	}
	return path.Join(scopeID, query)
}

func displayScope(scopeID string) string {
	if scopeID == "" {
		return "."
	}
	return scopeID
}

// FindProjectRoot walks up from the current directory to find a .felt directory.
func FindProjectRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("getting working directory: %w", err)
	}

	for {
		feltDir := filepath.Join(dir, DirName)
		if info, err := os.Stat(feltDir); err == nil && info.IsDir() {
			return dir, nil
		}

		parent := filepath.Dir(dir)
		if parent == dir {
			// Reached filesystem root
			return "", fmt.Errorf("no .felt directory found")
		}
		dir = parent
	}
}

func readMetadataFile(path, id string) (*Felt, error) {
	frontmatter, err := readFrontmatterFile(path)
	if err != nil {
		return nil, err
	}
	return parseFrontmatter(id, frontmatter)
}

func readFrontmatterFile(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	return readFrontmatter(file)
}

func fileFrontmatterHasTopLevelFields(path string, fields []string) (bool, error) {
	file, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer file.Close()

	return scanFrontmatterTopLevelFields(file, fields)
}

func frontmatterHasTopLevelFields(frontmatter []byte, fields []string) bool {
	if len(fields) == 0 {
		return true
	}

	remaining := make(map[string]struct{}, len(fields))
	for _, field := range fields {
		remaining[field] = struct{}{}
	}

	var node yaml.Node
	if err := yaml.Unmarshal(frontmatter, &node); err != nil || len(node.Content) == 0 {
		return false
	}
	mapping := node.Content[0]
	if mapping.Kind != yaml.MappingNode {
		return false
	}
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		delete(remaining, mapping.Content[i].Value)
		if len(remaining) == 0 {
			return true
		}
	}
	return false
}

func scanFrontmatterTopLevelFields(r io.Reader, fields []string) (bool, error) {
	if len(fields) == 0 {
		return true, nil
	}
	data, err := io.ReadAll(r)
	if err != nil {
		return false, fmt.Errorf("reading file: %w", err)
	}
	frontmatter, _, err := splitFrontmatter(data, false)
	if err != nil {
		return false, err
	}
	return frontmatterHasTopLevelFields(frontmatter, fields), nil
}

func readFrontmatter(r io.Reader) ([]byte, error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return nil, fmt.Errorf("reading file: %w", err)
	}
	frontmatter, _, err := splitFrontmatter(data, false)
	return frontmatter, err
}

func (s *Storage) nextAvailableMigrationID(baseID string, reserved map[string]struct{}) (string, error) {
	for n := 1; ; n++ {
		candidate := baseID
		if n > 1 {
			candidate = disambiguateID(baseID, n)
		}
		if _, ok := reserved[candidate]; ok {
			continue
		}
		if _, err := os.Stat(s.Path(candidate)); err == nil {
			continue
		} else if !os.IsNotExist(err) {
			return "", fmt.Errorf("checking id %s: %w", candidate, err)
		}
		return candidate, nil
	}
}

func remapIDPrefix(id, oldPrefix, newPrefix string) (string, bool) {
	id = path.Clean(id)
	oldPrefix = path.Clean(oldPrefix)
	newPrefix = path.Clean(newPrefix)
	if id == oldPrefix {
		return newPrefix, true
	}
	if strings.HasPrefix(id, oldPrefix+"/") {
		return newPrefix + strings.TrimPrefix(id, oldPrefix), true
	}
	return id, false
}
