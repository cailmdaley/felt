package felt

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestNewStorage(t *testing.T) {
	s := NewStorage("/tmp/test-project")
	if s.root != "/tmp/test-project/.felt" {
		t.Errorf("root = %q, want %q", s.root, "/tmp/test-project/.felt")
	}
}

func TestStorageInit(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)

	// Should not exist initially
	if s.Exists() {
		t.Error("Exists() should be false before Init()")
	}

	// Init should create directory
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	if !s.Exists() {
		t.Error("Exists() should be true after Init()")
	}

	// Init again should work (idempotent)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() second call error: %v", err)
	}
}

func TestStorageWriteRead(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	f := &Felt{
		ID:        "test-task-12345678",
		Title:     "Test Task",
		Status:    StatusOpen,
		DependsOn: Dependencies{{ID: "dep-a-aaaaaaaa"}},
		CreatedAt: time.Now(),
		Body:      "Test body content.",
	}

	// Write
	if err := s.Write(f); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	// Verify file exists
	path := s.Path(f.ID)
	if _, err := os.Stat(path); os.IsNotExist(err) {
		t.Fatal("File should exist after Write()")
	}

	// Read back
	read, err := s.Read(f.ID)
	if err != nil {
		t.Fatalf("Read() error: %v", err)
	}

	// Verify fields
	if read.ID != f.ID {
		t.Errorf("ID = %q, want %q", read.ID, f.ID)
	}
	if read.Title != f.Title {
		t.Errorf("Title = %q, want %q", read.Title, f.Title)
	}
	if read.Status != f.Status {
		t.Errorf("Status = %q, want %q", read.Status, f.Status)
	}
	if read.Body != f.Body {
		t.Errorf("Body = %q, want %q", read.Body, f.Body)
	}
	if len(read.DependsOn) != 1 || read.DependsOn[0].ID != "dep-a-aaaaaaaa" {
		t.Errorf("DependsOn = %v, want [{dep-a-aaaaaaaa }]", read.DependsOn)
	}
}

func TestStorageReadNonExistent(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	_, err := s.Read("nonexistent-12345678")
	if err == nil {
		t.Error("Read() should error for non-existent file")
	}
}

func TestStorageDelete(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	f, _ := New("Delete Me")
	s.Write(f)

	// Verify exists
	if _, err := s.Read(f.ID); err != nil {
		t.Fatal("Felt should exist before delete")
	}

	// Delete
	if err := s.Delete(f.ID); err != nil {
		t.Fatalf("Delete() error: %v", err)
	}

	// Verify gone
	if _, err := s.Read(f.ID); err == nil {
		t.Error("Felt should not exist after delete")
	}
}

func TestStorageDeleteNonExistent(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	err := s.Delete("nonexistent-12345678")
	if err == nil {
		t.Error("Delete() should error for non-existent file")
	}
}

func TestStorageList(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	// Empty list initially
	felts, err := s.List()
	if err != nil {
		t.Fatalf("List() error: %v", err)
	}
	if len(felts) != 0 {
		t.Errorf("List() should be empty, got %d", len(felts))
	}

	// Add some felts
	f1, _ := New("Task One")
	f2, _ := New("Task Two")
	f3, _ := New("Task Three")
	s.Write(f1)
	s.Write(f2)
	s.Write(f3)

	felts, err = s.List()
	if err != nil {
		t.Fatalf("List() error: %v", err)
	}
	if len(felts) != 3 {
		t.Errorf("List() should have 3 felts, got %d", len(felts))
	}
}

func TestStorageListIgnoresNonMdFiles(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	// Create a non-.md file in .felt/
	nonMdPath := filepath.Join(s.root, "config")
	os.WriteFile(nonMdPath, []byte("not a felt"), 0644)

	// Also create a valid felt
	f, _ := New("Valid Felt")
	s.Write(f)

	felts, err := s.List()
	if err != nil {
		t.Fatalf("List() error: %v", err)
	}
	if len(felts) != 1 {
		t.Errorf("List() should have 1 felt, got %d", len(felts))
	}
}

func TestStorageListIgnoresDirectories(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	// Create a subdirectory in .felt/
	subdir := filepath.Join(s.root, "archive")
	os.Mkdir(subdir, 0755)

	// Create a valid felt
	f, _ := New("Valid Felt")
	s.Write(f)

	felts, err := s.List()
	if err != nil {
		t.Fatalf("List() error: %v", err)
	}
	if len(felts) != 1 {
		t.Errorf("List() should have 1 felt, got %d", len(felts))
	}
}

func TestStorageFind(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	f1, _ := New("Alpha Task")
	f2, _ := New("Beta Task")
	s.Write(f1)
	s.Write(f2)

	// Find by full ID
	found, err := s.Find(f1.ID)
	if err != nil {
		t.Fatalf("Find() error: %v", err)
	}
	if found.ID != f1.ID {
		t.Errorf("Found ID = %q, want %q", found.ID, f1.ID)
	}

	// Find by prefix
	found, err = s.Find("alpha-task")
	if err != nil {
		t.Fatalf("Find() by prefix error: %v", err)
	}
	if found.ID != f1.ID {
		t.Errorf("Found by prefix ID = %q, want %q", found.ID, f1.ID)
	}
}

func TestStorageFindNotFound(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	_, err := s.Find("nonexistent")
	if err == nil {
		t.Error("Find() should error when no match")
	}
}

func TestStorageFindAmbiguous(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	// Create two felts with similar IDs
	f1 := &Felt{
		ID:        "task-12345678",
		Title:     "Task 1",
		Status:    StatusOpen,
		CreatedAt: time.Now(),
	}
	f2 := &Felt{
		ID:        "task-87654321",
		Title:     "Task 2",
		Status:    StatusOpen,
		CreatedAt: time.Now(),
	}
	s.Write(f1)
	s.Write(f2)

	// "task" prefix matches both
	_, err := s.Find("task")
	if err == nil {
		t.Error("Find() should error when ambiguous")
	}
}

func TestStoragePath(t *testing.T) {
	s := NewStorage("/project")
	path := s.Path("test-12345678")
	expected := "/project/.felt/test-12345678.md"
	if path != expected {
		t.Errorf("Path() = %q, want %q", path, expected)
	}
}

func TestFindProjectRoot(t *testing.T) {
	// Create a nested directory structure with .felt at the top
	rootDir := t.TempDir()
	feltDir := filepath.Join(rootDir, ".felt")
	os.Mkdir(feltDir, 0755)

	nested := filepath.Join(rootDir, "a", "b", "c")
	os.MkdirAll(nested, 0755)

	// Change to nested directory
	oldWd, _ := os.Getwd()
	defer os.Chdir(oldWd)
	os.Chdir(nested)

	// FindProjectRoot should find the root
	found, err := FindProjectRoot()
	if err != nil {
		t.Fatalf("FindProjectRoot() error: %v", err)
	}
	// Resolve symlinks for comparison (macOS has /var -> /private/var)
	wantResolved, _ := filepath.EvalSymlinks(rootDir)
	foundResolved, _ := filepath.EvalSymlinks(found)
	if foundResolved != wantResolved {
		t.Errorf("FindProjectRoot() = %q, want %q", found, rootDir)
	}
}

func TestFindProjectRootNotFound(t *testing.T) {
	// Create a temp directory with no .felt
	dir := t.TempDir()

	oldWd, _ := os.Getwd()
	defer os.Chdir(oldWd)
	os.Chdir(dir)

	_, err := FindProjectRoot()
	if err == nil {
		t.Error("FindProjectRoot() should error when no .felt found")
	}
}
