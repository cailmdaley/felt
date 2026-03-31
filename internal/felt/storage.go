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
	var files []fiberFile
	err := filepath.WalkDir(s.root, func(fullPath string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() || !strings.HasSuffix(d.Name(), FileExt) {
			return nil
		}
		rel, err := filepath.Rel(s.root, fullPath)
		if err != nil {
			return err
		}
		id, ok := fiberIDFromRelativePath(rel)
		if !ok {
			return nil
		}
		files = append(files, fiberFile{id: id, path: fullPath})
		return nil
	})
	if err != nil {
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
