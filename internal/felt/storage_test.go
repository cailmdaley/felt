package felt

import (
	"os"
	"path/filepath"
	"strings"
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
	data, err := os.ReadFile(filepath.Join(s.root, MystConfigName))
	if err != nil {
		t.Fatalf("reading myst.yml: %v", err)
	}
	if string(data) != defaultMystConfig {
		t.Fatalf("myst.yml = %q, want default config", string(data))
	}
	if !strings.Contains(string(data), "valid-page-frontmatter") {
		t.Fatalf("myst.yml missing frontmatter suppression: %q", string(data))
	}

	// Init again should work (idempotent)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() second call error: %v", err)
	}
}

func TestStorageInitCreatesMystConfigInExistingDirectory(t *testing.T) {
	dir := t.TempDir()
	feltDir := filepath.Join(dir, DirName)
	if err := os.MkdirAll(feltDir, 0755); err != nil {
		t.Fatalf("MkdirAll() error: %v", err)
	}

	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	if _, err := os.Stat(filepath.Join(feltDir, MystConfigName)); err != nil {
		t.Fatalf("myst.yml should be created in existing .felt/: %v", err)
	}
}

func TestStorageWriteRead(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	f := &Felt{
		ID:        "test-task",
		Title:     "Test Task",
		Status:    StatusOpen,
		DependsOn: Dependencies{{ID: "dep-a"}},
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
	if len(read.DependsOn) != 1 || read.DependsOn[0].ID != "dep-a" {
		t.Errorf("DependsOn = %v, want [{dep-a }]", read.DependsOn)
	}
}

func TestStorageReadNonExistent(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	_, err := s.Read("nonexistent")
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

	err := s.Delete("nonexistent")
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

func TestStorageReadMetadataSkipsBody(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	f := &Felt{
		ID:        "test-task",
		Title:     "Test Task",
		Status:    StatusOpen,
		CreatedAt: time.Now(),
		Outcome:   "Metadata survives",
		Body:      "Body should be skipped.",
	}
	if err := s.Write(f); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	read, err := s.ReadMetadata(f.ID)
	if err != nil {
		t.Fatalf("ReadMetadata() error: %v", err)
	}
	if read.Title != f.Title {
		t.Errorf("Title = %q, want %q", read.Title, f.Title)
	}
	if read.Outcome != f.Outcome {
		t.Errorf("Outcome = %q, want %q", read.Outcome, f.Outcome)
	}
	if read.Body != "" {
		t.Errorf("Body = %q, want empty", read.Body)
	}
}

func TestStorageListMetadataSkipsBody(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	f, _ := New("Task One")
	f.Body = "Body should be skipped."
	f.Outcome = "Outcome should remain."
	if err := s.Write(f); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	felts, err := s.ListMetadata()
	if err != nil {
		t.Fatalf("ListMetadata() error: %v", err)
	}
	if len(felts) != 1 {
		t.Fatalf("ListMetadata() returned %d felts, want 1", len(felts))
	}
	if felts[0].Outcome != f.Outcome {
		t.Errorf("Outcome = %q, want %q", felts[0].Outcome, f.Outcome)
	}
	if felts[0].Body != "" {
		t.Errorf("Body = %q, want empty", felts[0].Body)
	}
	if !felts[0].ModifiedAt.IsZero() {
		t.Errorf("ModifiedAt = %v, want zero without modtime scan", felts[0].ModifiedAt)
	}
}

func TestStorageListMetadataWithModTimePopulatesModifiedAt(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	f, _ := New("Task One")
	if err := s.Write(f); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	felts, err := s.ListMetadataWithModTime()
	if err != nil {
		t.Fatalf("ListMetadataWithModTime() error: %v", err)
	}
	if len(felts) != 1 {
		t.Fatalf("ListMetadataWithModTime() returned %d felts, want 1", len(felts))
	}
	if felts[0].ModifiedAt.IsZero() {
		t.Fatal("ModifiedAt should be populated when explicitly requested")
	}
}

func TestStorageFindMetadataSkipsBody(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	f := &Felt{
		ID:        "test-task",
		Title:     "Test Task",
		Status:    StatusOpen,
		CreatedAt: time.Now(),
		Outcome:   "Metadata survives",
		Body:      "Body should be skipped.",
	}
	if err := s.Write(f); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	found, err := s.FindMetadata("test")
	if err != nil {
		t.Fatalf("FindMetadata() error: %v", err)
	}
	if found.ID != f.ID {
		t.Errorf("ID = %q, want %q", found.ID, f.ID)
	}
	if found.Outcome != f.Outcome {
		t.Errorf("Outcome = %q, want %q", found.Outcome, f.Outcome)
	}
	if found.Body != "" {
		t.Errorf("Body = %q, want empty", found.Body)
	}
	if found.ModifiedAt.IsZero() {
		t.Fatal("ModifiedAt should be populated for FindMetadata")
	}
}

func TestReadFrontmatter(t *testing.T) {
	content := strings.NewReader(`---
title: Test Task
status: open
created-at: 2026-01-01T10:00:00Z
---

Body should never be read.
`)

	frontmatter, err := readFrontmatter(content)
	if err != nil {
		t.Fatalf("readFrontmatter() error: %v", err)
	}

	got := string(frontmatter)
	if !strings.Contains(got, "title: Test Task") {
		t.Errorf("frontmatter = %q, want title", got)
	}
	if strings.Contains(got, "Body should never be read.") {
		t.Errorf("frontmatter = %q, should not include body", got)
	}
}

func TestReadFrontmatterErrors(t *testing.T) {
	tests := []struct {
		name    string
		content string
	}{
		{name: "empty", content: ""},
		{name: "missing opener", content: "title: nope\n"},
		{name: "missing closer", content: "---\ntitle: nope\n"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := readFrontmatter(strings.NewReader(tt.content))
			if err == nil {
				t.Fatalf("readFrontmatter() error = nil, want error")
			}
		})
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
		ID:        "task-2",
		Title:     "Task 1",
		Status:    StatusOpen,
		CreatedAt: time.Now(),
	}
	f2 := &Felt{
		ID:        "task-3",
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
	path := s.Path("test-path")
	expected := "/project/.felt/test-path/test-path.md"
	if path != expected {
		t.Errorf("Path() = %q, want %q", path, expected)
	}
}

func TestStoragePathNested(t *testing.T) {
	s := NewStorage("/project")
	path := s.Path("bao-analysis/damping-prior")
	expected := "/project/.felt/bao-analysis/damping-prior/damping-prior.md"
	if path != expected {
		t.Errorf("Path() = %q, want %q", path, expected)
	}
}

func TestStorageNextAvailableID(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	f := &Felt{
		ID:        "quick-gotcha",
		Title:     "Quick gotcha",
		CreatedAt: time.Now(),
	}
	if err := s.Write(f); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	id, err := s.NextAvailableID("quick-gotcha")
	if err != nil {
		t.Fatalf("NextAvailableID() error: %v", err)
	}
	if id != "quick-gotcha-2" {
		t.Fatalf("NextAvailableID() = %q, want %q", id, "quick-gotcha-2")
	}
}

func TestStorageFindNestedByBasename(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	f := &Felt{
		ID:        "bao-analysis/damping-prior",
		Title:     "Damping Prior",
		CreatedAt: time.Now(),
	}
	if err := s.Write(f); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	found, err := s.Find("damping")
	if err != nil {
		t.Fatalf("Find() error: %v", err)
	}
	if found.ID != f.ID {
		t.Fatalf("Find() = %q, want %q", found.ID, f.ID)
	}
}

func TestStorageFindPrefersExactIDOverPrefix(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	for _, f := range []*Felt{
		{ID: "bao-analysis", Title: "BAO Analysis", CreatedAt: time.Now()},
		{ID: "bao-analysis/damping-prior", Title: "Damping Prior", CreatedAt: time.Now()},
	} {
		if err := s.Write(f); err != nil {
			t.Fatalf("Write(%s) error: %v", f.ID, err)
		}
	}

	found, err := s.Find("bao-analysis")
	if err != nil {
		t.Fatalf("Find() error: %v", err)
	}
	if found.ID != "bao-analysis" {
		t.Fatalf("Find() = %q, want exact top-level ID", found.ID)
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

func TestStorageMoveSubtreeRewritesDependencies(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	parent := &Felt{
		ID:        "bao-analysis",
		Title:     "BAO Analysis",
		CreatedAt: time.Now(),
	}
	child := &Felt{
		ID:        "damping-prior",
		Title:     "Damping Prior",
		CreatedAt: time.Now(),
		DependsOn: Dependencies{{ID: "bao-analysis"}},
	}
	grandchild := &Felt{
		ID:        "damping-prior/contour-plot",
		Title:     "Contour Plot",
		CreatedAt: time.Now(),
		DependsOn: Dependencies{{ID: "damping-prior"}},
	}
	consumer := &Felt{
		ID:        "consumer",
		Title:     "Consumer",
		CreatedAt: time.Now(),
		DependsOn: Dependencies{{ID: "damping-prior/contour-plot"}},
	}

	for _, f := range []*Felt{parent, child, grandchild, consumer} {
		if err := s.Write(f); err != nil {
			t.Fatalf("Write(%s) error: %v", f.ID, err)
		}
	}

	if err := s.MoveSubtree("damping-prior", "bao-analysis/damping-prior"); err != nil {
		t.Fatalf("MoveSubtree() error: %v", err)
	}

	if _, err := s.Read("damping-prior"); err == nil {
		t.Fatal("old child ID should no longer exist")
	}
	moved, err := s.Read("bao-analysis/damping-prior")
	if err != nil {
		t.Fatalf("Read moved child: %v", err)
	}
	if got := moved.DependsOn[0].ID; got != "bao-analysis" {
		t.Fatalf("moved child dependency = %q, want %q", got, "bao-analysis")
	}

	descendant, err := s.Read("bao-analysis/damping-prior/contour-plot")
	if err != nil {
		t.Fatalf("Read moved descendant: %v", err)
	}
	if got := descendant.DependsOn[0].ID; got != "bao-analysis/damping-prior" {
		t.Fatalf("moved descendant dependency = %q, want %q", got, "bao-analysis/damping-prior")
	}

	updatedConsumer, err := s.Read("consumer")
	if err != nil {
		t.Fatalf("Read consumer: %v", err)
	}
	if got := updatedConsumer.DependsOn[0].ID; got != "bao-analysis/damping-prior/contour-plot" {
		t.Fatalf("consumer dependency = %q, want rewritten descendant ID", got)
	}
}

func TestStorageMoveSubtreeRejectsSelfNesting(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	f := &Felt{
		ID:        "bao-analysis",
		Title:     "BAO Analysis",
		CreatedAt: time.Now(),
	}
	if err := s.Write(f); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	if err := s.MoveSubtree("bao-analysis", "bao-analysis/damping-prior"); err == nil {
		t.Fatal("MoveSubtree should reject moving into its own subtree")
	}
}

func TestStorageMigrateFlatFiles(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	legacyA := `---
title: Quick gotcha
created-at: 2026-03-15T10:00:00Z
depends-on:
  - bao-analysis-d34db33f
---

Quick note.
`
	legacyB := `---
title: BAO Analysis
created-at: 2026-03-16T10:00:00Z
---

Analysis body.
`
	if err := os.WriteFile(filepath.Join(s.root, "quick-gotcha-deadbeef.md"), []byte(legacyA), 0644); err != nil {
		t.Fatalf("write legacyA: %v", err)
	}
	if err := os.WriteFile(filepath.Join(s.root, "bao-analysis-d34db33f.md"), []byte(legacyB), 0644); err != nil {
		t.Fatalf("write legacyB: %v", err)
	}

	result, err := s.MigrateFlatFiles(false)
	if err != nil {
		t.Fatalf("MigrateFlatFiles() error: %v", err)
	}
	if len(result.Entries) != 2 {
		t.Fatalf("migration entries = %#v", result.Entries)
	}

	if _, err := os.Stat(filepath.Join(s.root, "quick-gotcha-deadbeef.md")); !os.IsNotExist(err) {
		t.Fatalf("legacy flat file should be removed, err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(s.root, "quick-gotcha", "quick-gotcha.md")); err != nil {
		t.Fatalf("migrated quick-gotcha missing: %v", err)
	}

	migrated, err := s.Read("quick-gotcha")
	if err != nil {
		t.Fatalf("Read migrated quick-gotcha: %v", err)
	}
	if got := migrated.DependsOn[0].ID; got != "bao-analysis" {
		t.Fatalf("dependency rewrite = %q, want %q", got, "bao-analysis")
	}
	if !strings.HasPrefix(migrated.Body, "(quick-gotcha)=") {
		t.Fatalf("migrated body should have MyST anchor, got %q", migrated.Body)
	}
}

func TestStorageMigrateFlatFilesDryRun(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	legacy := `---
title: Quick gotcha
created-at: 2026-03-15T10:00:00Z
---

Body.
`
	if err := os.WriteFile(filepath.Join(s.root, "quick-gotcha-deadbeef.md"), []byte(legacy), 0644); err != nil {
		t.Fatalf("write legacy: %v", err)
	}

	result, err := s.MigrateFlatFiles(true)
	if err != nil {
		t.Fatalf("MigrateFlatFiles(true) error: %v", err)
	}
	if len(result.Entries) != 1 || result.Entries[0].NewID != "quick-gotcha" {
		t.Fatalf("dry-run entries = %#v", result.Entries)
	}
	if _, err := os.Stat(filepath.Join(s.root, "quick-gotcha-deadbeef.md")); err != nil {
		t.Fatalf("dry-run should keep legacy file: %v", err)
	}
	if _, err := os.Stat(filepath.Join(s.root, "quick-gotcha", "quick-gotcha.md")); !os.IsNotExist(err) {
		t.Fatalf("dry-run should not create migrated directory, err=%v", err)
	}
}
