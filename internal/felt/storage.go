package felt

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	// DirName is the directory where felt files are stored.
	DirName = ".felt"
	// FileExt is the extension for felt files.
	FileExt = ".md"
)

// Storage handles reading and writing felt files.
type Storage struct {
	root string // Path to .felt directory
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
	return nil
}

// Exists returns true if the .felt directory exists.
func (s *Storage) Exists() bool {
	info, err := os.Stat(s.root)
	return err == nil && info.IsDir()
}

// Path returns the full path for a felt file.
func (s *Storage) Path(id string) string {
	return filepath.Join(s.root, id+FileExt)
}

// Write saves a felt to disk.
func (s *Storage) Write(f *Felt) error {
	data, err := f.Marshal()
	if err != nil {
		return err
	}

	path := s.Path(f.ID)
	if err := os.WriteFile(path, data, 0644); err != nil {
		return fmt.Errorf("writing file %s: %w", path, err)
	}
	return nil
}

// Read loads a felt from disk by ID.
func (s *Storage) Read(id string) (*Felt, error) {
	path := s.Path(id)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading file %s: %w", path, err)
	}
	return Parse(id, data)
}

// Delete removes a felt from disk.
func (s *Storage) Delete(id string) error {
	path := s.Path(id)
	if err := os.Remove(path); err != nil {
		return fmt.Errorf("deleting file %s: %w", path, err)
	}
	return nil
}

// List returns all felts in the storage.
func (s *Storage) List() ([]*Felt, error) {
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return nil, fmt.Errorf("reading directory: %w", err)
	}

	var felts []*Felt
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasSuffix(name, FileExt) {
			continue
		}

		id := strings.TrimSuffix(name, FileExt)
		f, err := s.Read(id)
		if err != nil {
			// Log but continue on parse errors
			fmt.Fprintf(os.Stderr, "warning: failed to parse %s: %v\n", name, err)
			continue
		}
		// Populate ModifiedAt from file stat
		if info, err := entry.Info(); err == nil {
			f.ModifiedAt = info.ModTime()
		}
		felts = append(felts, f)
	}

	return felts, nil
}

// Find returns the first felt matching the ID prefix.
func (s *Storage) Find(query string) (*Felt, error) {
	felts, err := s.List()
	if err != nil {
		return nil, err
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
