package felt

import (
	"os"
	"path/filepath"
	"reflect"
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
		Name:      "Test Task",
		Status:    StatusOpen,
		Inputs:    []ASTRAInput{{ID: "dep_a", From: "dep-a.output"}},
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
	if read.Name != f.Name {
		t.Errorf("Name = %q, want %q", read.Name, f.Name)
	}
	if read.Status != f.Status {
		t.Errorf("Status = %q, want %q", read.Status, f.Status)
	}
	if read.Body != f.Body {
		t.Errorf("Body = %q, want %q", read.Body, f.Body)
	}
	if len(read.Inputs) != 1 || read.Inputs[0].From != "dep-a.output" {
		t.Errorf("Inputs = %v, want [{dep_a dep-a.output}]", read.Inputs)
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

	f, _ := New("delete-me", "Delete me")
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
	f1, _ := New("task-one", "Task one")
	f2, _ := New("task-two", "Task two")
	f3, _ := New("task-three", "Task three")
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
		Name:      "Test Task",
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
	if read.Name != f.Name {
		t.Errorf("Name = %q, want %q", read.Name, f.Name)
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

	f, _ := New("task-one", "Task one")
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

	f, _ := New("task-one", "Task one")
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
		Name:      "Test Task",
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
	f, _ := New("valid-felt", "Valid felt")
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
	f, _ := New("valid-felt", "Valid felt")
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

	f1, _ := New("alpha-task", "Alpha task")
	f2, _ := New("beta-task", "Beta task")
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
		Name:      "Task 1",
		Status:    StatusOpen,
		CreatedAt: time.Now(),
	}
	f2 := &Felt{
		ID:        "task-3",
		Name:      "Task 2",
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
		Name:      "Quick gotcha",
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

func TestStorageCheckAvailableID(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	f := &Felt{
		ID:        "quick-gotcha",
		Name:      "Quick gotcha",
		CreatedAt: time.Now(),
	}
	if err := s.Write(f); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	if err := s.CheckAvailableID("fresh-fiber"); err != nil {
		t.Fatalf("CheckAvailableID(fresh-fiber) error: %v", err)
	}
	if err := s.CheckAvailableID("quick-gotcha"); err == nil {
		t.Fatal("CheckAvailableID should reject an existing ID")
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
		Name:      "Damping Prior",
		CreatedAt: time.Now(),
	}
	if err := s.Write(f); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	found, err := s.FindInScope("bao-analysis", "damping")
	if err != nil {
		t.Fatalf("FindInScope() error: %v", err)
	}
	if found.ID != f.ID {
		t.Fatalf("FindInScope() = %q, want %q", found.ID, f.ID)
	}
}

func TestStorageFindNestedByBasenameRequiresScope(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	f := &Felt{
		ID:        "bao-analysis/damping-prior",
		Name:      "Damping Prior",
		CreatedAt: time.Now(),
	}
	if err := s.Write(f); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	if _, err := s.Find("damping"); err == nil {
		t.Fatal("Find() without scope should not resolve nested basename")
	}
}

func TestStorageFindPrefersExactIDOverPrefix(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	for _, f := range []*Felt{
		{ID: "bao-analysis", Name: "BAO Analysis", CreatedAt: time.Now()},
		{ID: "bao-analysis/damping-prior", Name: "Damping Prior", CreatedAt: time.Now()},
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

func TestResolveScopedIDWalksUpLexicalScopes(t *testing.T) {
	ids := []string{
		"project",
		"project/analysis",
		"project/question",
		"project/analysis/method",
	}

	got, err := ResolveScopedID(ids, "project/analysis", "question")
	if err != nil {
		t.Fatalf("ResolveScopedID() error: %v", err)
	}
	if got != "project/question" {
		t.Fatalf("ResolveScopedID() = %q, want %q", got, "project/question")
	}

	got, err = ResolveScopedID(ids, "project/analysis", "method")
	if err != nil {
		t.Fatalf("ResolveScopedID() nested error: %v", err)
	}
	if got != "project/analysis/method" {
		t.Fatalf("ResolveScopedID() = %q, want %q", got, "project/analysis/method")
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

func TestStorageMoveSubtreeRewritesInputRefs(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	parent := &Felt{
		ID:        "bao-analysis",
		Name:      "BAO Analysis",
		CreatedAt: time.Now(),
	}
	child := &Felt{
		ID:        "damping-prior",
		Name:      "Damping Prior",
		CreatedAt: time.Now(),
		Inputs:    []ASTRAInput{{ID: "analysis_input", From: "bao-analysis.posterior"}},
	}
	grandchild := &Felt{
		ID:        "damping-prior/contour-plot",
		Name:      "Contour Plot",
		CreatedAt: time.Now(),
		Inputs:    []ASTRAInput{{ID: "plot_input", From: "damping-prior.fit"}},
	}
	consumer := &Felt{
		ID:        "consumer",
		Name:      "Consumer",
		CreatedAt: time.Now(),
		Inputs:    []ASTRAInput{{ID: "consumer_input", From: "damping-prior/contour-plot.figure"}},
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
	if got := moved.Inputs[0].From; got != "bao-analysis.posterior" {
		t.Fatalf("moved child input = %q, want %q", got, "bao-analysis.posterior")
	}

	descendant, err := s.Read("bao-analysis/damping-prior/contour-plot")
	if err != nil {
		t.Fatalf("Read moved descendant: %v", err)
	}
	if got := descendant.Inputs[0].From; got != "bao-analysis/damping-prior.fit" {
		t.Fatalf("moved descendant input = %q, want %q", got, "bao-analysis/damping-prior.fit")
	}

	updatedConsumer, err := s.Read("consumer")
	if err != nil {
		t.Fatalf("Read consumer: %v", err)
	}
	if got := updatedConsumer.Inputs[0].From; got != "bao-analysis/damping-prior/contour-plot.figure" {
		t.Fatalf("consumer input = %q, want rewritten descendant ref", got)
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
		Name:      "BAO Analysis",
		CreatedAt: time.Now(),
	}
	if err := s.Write(f); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	if err := s.MoveSubtree("bao-analysis", "bao-analysis/damping-prior"); err == nil {
		t.Fatal("MoveSubtree should reject moving into its own subtree")
	}
}

func TestStorageMoveSubtreeRejectsExistingDestination(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	for _, f := range []*Felt{
		{ID: "bao-analysis", Name: "BAO Analysis", CreatedAt: time.Now()},
		{ID: "bao-analysis/damping-prior", Name: "Existing Child", CreatedAt: time.Now()},
		{ID: "damping-prior", Name: "Top-level Child", CreatedAt: time.Now()},
	} {
		if err := s.Write(f); err != nil {
			t.Fatalf("Write(%s) error: %v", f.ID, err)
		}
	}

	if err := s.MoveSubtree("damping-prior", "bao-analysis/damping-prior"); err == nil {
		t.Fatal("MoveSubtree should reject an existing destination")
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
inputs:
  - id: parent_input
    from: bao-analysis-d34db33f.posterior
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
	if got := migrated.Inputs[0].From; got != "bao-analysis.posterior" {
		t.Fatalf("input rewrite = %q, want %q", got, "bao-analysis.posterior")
	}
	if migrated.Body != "Quick note." {
		t.Fatalf("migrated body should preserve plain markdown body, got %q", migrated.Body)
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

func TestStorageMigrateRewritesPreExistingDirectoryInputs(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	// Flat file that will be migrated
	legacy := `---
title: BAO Analysis
created-at: 2026-03-16T10:00:00Z
---

Analysis body.
`
	if err := os.WriteFile(filepath.Join(s.root, "bao-analysis-d34db33f.md"), []byte(legacy), 0644); err != nil {
		t.Fatalf("write legacy: %v", err)
	}

	// Pre-existing directory fiber with a stale hex input ref
	preExisting := &Felt{
		ID:        "session-hub",
		Name:      "Session hub",
		CreatedAt: time.Now(),
		Inputs:    []ASTRAInput{{ID: "analysis_input", From: "bao-analysis-d34db33f.posterior"}},
		Body:      "(session-hub)=\n# Session hub",
	}
	if err := s.Write(preExisting); err != nil {
		t.Fatalf("write pre-existing: %v", err)
	}

	result, err := s.MigrateFlatFiles(false)
	if err != nil {
		t.Fatalf("MigrateFlatFiles() error: %v", err)
	}
	if len(result.Entries) != 1 {
		t.Fatalf("expected 1 migration entry, got %d", len(result.Entries))
	}

	// The pre-existing directory fiber should have its input ref rewritten
	hub, err := s.Read("session-hub")
	if err != nil {
		t.Fatalf("Read session-hub: %v", err)
	}
	if got := hub.Inputs[0].From; got != "bao-analysis.posterior" {
		t.Fatalf("pre-existing input rewrite = %q, want %q", got, "bao-analysis.posterior")
	}
}

func TestStorageMigrateRenamesTitleAndStripsMystAnchor(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	legacy := `---
title: Session hub
created-at: 2026-03-16T10:00:00Z
---

(session-hub)=

# Session hub
`
	if err := os.MkdirAll(filepath.Join(s.root, "session-hub"), 0755); err != nil {
		t.Fatalf("mkdir session-hub: %v", err)
	}
	targetPath := filepath.Join(s.root, "session-hub", "session-hub.md")
	if err := os.WriteFile(targetPath, []byte(legacy), 0644); err != nil {
		t.Fatalf("write legacy directory fiber: %v", err)
	}

	result, err := s.Migrate(false)
	if err != nil {
		t.Fatalf("Migrate() error: %v", err)
	}
	if got, want := result.TitleToNameIDs, []string{"session-hub"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("TitleToNameIDs = %#v, want %#v", got, want)
	}
	if got, want := result.StrippedMystAnchorIDs, []string{"session-hub"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("StrippedMystAnchorIDs = %#v, want %#v", got, want)
	}

	data, err := os.ReadFile(targetPath)
	if err != nil {
		t.Fatalf("read migrated directory fiber: %v", err)
	}
	text := string(data)
	if strings.Contains(text, "title: Session hub") {
		t.Fatalf("migrate should remove legacy title field:\n%s", text)
	}
	if !strings.Contains(text, "name: Session hub") {
		t.Fatalf("migrate should write name field:\n%s", text)
	}
	if strings.Contains(text, "(session-hub)=") {
		t.Fatalf("migrate should strip legacy MyST anchor:\n%s", text)
	}
}

func TestStorageMigrateDryRunReportsTitleAndAnchorWithoutWriting(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	legacy := `---
title: Session hub
created-at: 2026-03-16T10:00:00Z
---

(session-hub)=

# Session hub
`
	if err := os.MkdirAll(filepath.Join(s.root, "session-hub"), 0755); err != nil {
		t.Fatalf("mkdir session-hub: %v", err)
	}
	targetPath := filepath.Join(s.root, "session-hub", "session-hub.md")
	if err := os.WriteFile(targetPath, []byte(legacy), 0644); err != nil {
		t.Fatalf("write legacy directory fiber: %v", err)
	}

	result, err := s.Migrate(true)
	if err != nil {
		t.Fatalf("Migrate(true) error: %v", err)
	}
	if got, want := result.TitleToNameIDs, []string{"session-hub"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("TitleToNameIDs = %#v, want %#v", got, want)
	}
	if got, want := result.StrippedMystAnchorIDs, []string{"session-hub"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("StrippedMystAnchorIDs = %#v, want %#v", got, want)
	}

	data, err := os.ReadFile(targetPath)
	if err != nil {
		t.Fatalf("read dry-run directory fiber: %v", err)
	}
	if string(data) != legacy {
		t.Fatalf("dry-run should not rewrite file:\n%s", string(data))
	}
}
