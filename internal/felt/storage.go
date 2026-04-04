package felt

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
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
	id   string
	path string
}

type MigrationEntry struct {
	OldID string
	NewID string
}

type MigrationResult struct {
	Entries []MigrationEntry
}

// NewStorage creates a storage instance for the given directory.
// The directory should be the project root (containing .felt/).
func NewStorage(projectRoot string) *Storage {
	return &Storage{
		root: filepath.Join(projectRoot, DirName),
	}
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

// Path returns the full path for a felt file.
func (s *Storage) Path(id string) string {
	slug := filepath.Base(filepath.Clean(id))
	return filepath.Join(s.root, filepath.FromSlash(id), slug+FileExt)
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

// Write saves a felt to disk.
func (s *Storage) Write(f *Felt) error {
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
	return s.findWithMode(query, ParseMetadataOnly)
}

func (s *Storage) readWithMode(id string, mode ParseMode) (*Felt, error) {
	path := s.Path(id)
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
// dependency references across the repository.
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
		for i, dep := range clone.DependsOn {
			if remappedDep, ok := remapIDPrefix(dep.ID, oldID, newID); ok {
				clone.DependsOn[i].ID = remappedDep
			}
		}
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

// MigrateFlatFiles converts legacy top-level flat markdown fibers to
// directory-based fibers with slug IDs, rewriting dependency references.
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

	result := &MigrationResult{Entries: make([]MigrationEntry, 0, len(legacy))}
	if len(legacy) == 0 {
		return result, nil
	}

	used := map[string]struct{}{}
	for _, f := range legacy {
		baseID, err := GenerateID(f.felt.Title)
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
		for i, dep := range f.DependsOn {
			if newDepID, ok := idMap[dep.ID]; ok {
				f.DependsOn[i].ID = newDepID
			}
		}
		if err := s.Write(f); err != nil {
			return nil, err
		}
	}

	for _, item := range legacy {
		if err := os.Remove(item.path); err != nil {
			return nil, fmt.Errorf("removing legacy fiber %s: %w", item.path, err)
		}
	}

	// Rewrite stale hex-suffixed depends-on in pre-existing directory fibers.
	allFibers, err := s.List()
	if err != nil {
		return nil, fmt.Errorf("listing fibers for dep rewrite: %w", err)
	}
	for _, f := range allFibers {
		changed := false
		for i, dep := range f.DependsOn {
			if newID, ok := idMap[dep.ID]; ok {
				f.DependsOn[i].ID = newID
				changed = true
			}
		}
		if changed {
			if err := s.Write(f); err != nil {
				return nil, fmt.Errorf("rewriting deps in %s: %w", f.ID, err)
			}
		}
	}

	return result, nil
}

// List returns all felts in the storage.
func (s *Storage) List() ([]*Felt, error) {
	return s.listWithMode(ParseFull, false)
}

// ListMetadata returns all felts with frontmatter only.
func (s *Storage) ListMetadata() ([]*Felt, error) {
	return s.listWithMode(ParseMetadataOnly, false)
}

// ListMetadataWithModTime returns metadata plus file modification times.
func (s *Storage) ListMetadataWithModTime() ([]*Felt, error) {
	return s.listWithMode(ParseMetadataOnly, true)
}

func (s *Storage) listWithMode(mode ParseMode, includeModTime bool) ([]*Felt, error) {
	files, err := s.listFiberFiles()
	if err != nil {
		return nil, err
	}

	var felts []*Felt
	for _, file := range files {
		f, err := s.readWithMode(file.id, mode)
		if err != nil {
			fmt.Fprintf(os.Stderr, "warning: failed to parse %s: %v\n", file.path, err)
			continue
		}
		if includeModTime {
			if info, err := os.Stat(file.path); err == nil {
				f.ModifiedAt = info.ModTime()
			}
		}
		felts = append(felts, f)
	}

	return felts, nil
}

// Find returns the first felt matching the ID prefix or basename.
func (s *Storage) Find(query string) (*Felt, error) {
	return s.findWithMode(query, ParseFull)
}

func (s *Storage) findWithMode(query string, mode ParseMode) (*Felt, error) {
	files, err := s.listFiberFiles()
	if err != nil {
		return nil, err
	}

	query = path.Clean(query)
	for _, file := range files {
		if path.Clean(file.id) != query {
			continue
		}
		f, err := s.readWithMode(file.id, mode)
		if err != nil {
			return nil, err
		}
		if info, err := os.Stat(file.path); err == nil {
			f.ModifiedAt = info.ModTime()
		}
		return f, nil
	}

	var matchIDs []string
	matchPaths := make(map[string]string)
	for _, file := range files {
		if MatchesIDQuery(file.id, query) {
			matchIDs = append(matchIDs, file.id)
			matchPaths[file.id] = file.path
		}
	}

	switch len(matchIDs) {
	case 0:
		return nil, fmt.Errorf("no felt found matching %q", query)
	case 1:
		f, err := s.readWithMode(matchIDs[0], mode)
		if err != nil {
			return nil, err
		}
		if info, err := os.Stat(matchPaths[matchIDs[0]]); err == nil {
			f.ModifiedAt = info.ModTime()
		}
		return f, nil
	default:
		return nil, fmt.Errorf("ambiguous ID %q matches: %s", query, strings.Join(matchIDs, ", "))
	}
}

func (s *Storage) listFiberFiles() ([]fiberFile, error) {
	// Resolve symlinks on the root so WalkDir descends into symlinked .felt/ dirs
	root, err := filepath.EvalSymlinks(s.root)
	if err != nil {
		return nil, fmt.Errorf("resolving .felt path: %w", err)
	}
	var files []fiberFile
	var walkFn func(walkRoot string) error
	walkFn = func(walkRoot string) error {
		return filepath.WalkDir(walkRoot, func(fullPath string, d fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			// Follow symlinked directories (e.g. project .felt/ dirs inside loom)
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
					return walkFn(fullPath)
				}
			}
			if d.IsDir() || !strings.HasSuffix(d.Name(), FileExt) {
				return nil
			}
			// Resolve the full path through any symlinks for Rel computation
			resolved, err := filepath.EvalSymlinks(fullPath)
			if err != nil {
				resolved = fullPath
			}
			// Compute rel from root, trying both resolved and unresolved paths
			rel, err := filepath.Rel(root, resolved)
			if err != nil {
				rel, err = filepath.Rel(root, fullPath)
				if err != nil {
					return err
				}
			}
			id, ok := fiberIDFromRelativePath(rel)
			if !ok {
				return nil
			}
			files = append(files, fiberFile{id: id, path: fullPath})
			return nil
		})
	}
	if err := walkFn(root); err != nil {
		return nil, fmt.Errorf("walking .felt directory: %w", err)
	}
	return files, nil
}

func fiberIDFromRelativePath(rel string) (string, bool) {
	rel = filepath.Clean(rel)
	dir := filepath.Dir(rel)
	if dir == "." {
		return "", false
	}
	base := strings.TrimSuffix(filepath.Base(rel), FileExt)
	if filepath.Base(dir) != base {
		return "", false
	}
	return filepath.ToSlash(dir), true
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

// FindByPrefix finds a fiber matching a query in an existing slice.
// Use this instead of Find when you already have the list from List().
func FindByPrefix(felts []*Felt, query string) (*Felt, error) {
	query = path.Clean(query)
	for _, f := range felts {
		if path.Clean(f.ID) == query {
			return f, nil
		}
	}

	var matches []*Felt
	for _, f := range felts {
		if f.MatchesID(query) {
			matches = append(matches, f)
		}
	}

	switch len(matches) {
	case 0:
		return nil, fmt.Errorf("no felt found matching %q", query)
	case 1:
		return matches[0], nil
	default:
		var ids []string
		for _, m := range matches {
			ids = append(ids, m.ID)
		}
		return nil, fmt.Errorf("ambiguous ID %q matches: %s", query, strings.Join(ids, ", "))
	}
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
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	frontmatter, err := readFrontmatter(file)
	if err != nil {
		return nil, err
	}
	return parseFrontmatter(id, frontmatter)
}

func readFrontmatter(r io.Reader) ([]byte, error) {
	scanner := bufio.NewScanner(r)

	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return nil, fmt.Errorf("scanning file: %w", err)
		}
		return nil, fmt.Errorf("empty file")
	}
	if strings.TrimSpace(scanner.Text()) != "---" {
		return nil, fmt.Errorf("file must start with ---")
	}

	var frontmatter strings.Builder
	foundClosing := false
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "---" {
			foundClosing = true
			break
		}
		frontmatter.WriteString(line)
		frontmatter.WriteByte('\n')
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scanning file: %w", err)
	}
	if !foundClosing {
		return nil, fmt.Errorf("unclosed frontmatter (missing closing ---)")
	}

	return []byte(frontmatter.String()), nil
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
