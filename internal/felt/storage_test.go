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
	gitignoreData, err := os.ReadFile(filepath.Join(s.root, GitignoreName))
	if err != nil {
		t.Fatalf("reading .gitignore: %v", err)
	}
	if string(gitignoreData) != defaultGitignore {
		t.Fatalf(".gitignore = %q, want default ignore", string(gitignoreData))
	}
	if !strings.Contains(string(gitignoreData), "index-sync.request") {
		t.Fatalf(".gitignore missing sync request ignore: %q", string(gitignoreData))
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
	if _, err := os.Stat(filepath.Join(feltDir, GitignoreName)); err != nil {
		t.Fatalf(".gitignore should be created in existing .felt/: %v", err)
	}
}

func TestStorageInitDoesNotOverwriteExistingGitignore(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := os.MkdirAll(s.root, 0755); err != nil {
		t.Fatalf("MkdirAll() error: %v", err)
	}
	customGitignore := "# user-owned ignore\ncustom-pattern\n"
	if err := os.WriteFile(filepath.Join(s.root, GitignoreName), []byte(customGitignore), 0644); err != nil {
		t.Fatalf("writing custom .gitignore: %v", err)
	}

	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(s.root, GitignoreName))
	if err != nil {
		t.Fatalf("reading .gitignore: %v", err)
	}
	if string(data) != customGitignore {
		t.Fatalf(".gitignore = %q, want custom content", string(data))
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
		CreatedAt: time.Now(),
		Body:      "Test body content.",
	}
	mustExtraField(t, f, "inputs", []map[string]any{{"id": "dep_a", "from": "dep-a.output"}})

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
	inputs := read.DataFlowInputs()
	if len(inputs) != 1 || inputs[0].From != "dep-a.output" {
		t.Errorf("Inputs = %v, want [{dep_a dep-a.output}]", inputs)
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

func TestStorageListMetadataHavingFrontmatterFields(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	shuttleDir := filepath.Join(dir, DirName, "with-shuttle")
	if err := os.MkdirAll(shuttleDir, 0755); err != nil {
		t.Fatalf("mkdir shuttle fixture: %v", err)
	}
	if err := os.WriteFile(filepath.Join(shuttleDir, "with-shuttle.md"), []byte(`---
name: With Shuttle
status: active
created-at: 2026-05-08T00:00:00Z
shuttle:
  enabled: true
  agent: codex
---

Body should not be hydrated.
`), 0644); err != nil {
		t.Fatalf("write shuttle fixture: %v", err)
	}

	plainDir := filepath.Join(dir, DirName, "plain")
	if err := os.MkdirAll(plainDir, 0755); err != nil {
		t.Fatalf("mkdir plain fixture: %v", err)
	}
	if err := os.WriteFile(filepath.Join(plainDir, "plain.md"), []byte(`---
name: Plain
status: active
created-at: 2026-05-08T00:00:00Z
---
`), 0644); err != nil {
		t.Fatalf("write plain fixture: %v", err)
	}

	felts, err := s.ListMetadataWithModTimeHavingFrontmatterFields([]string{"shuttle"})
	if err != nil {
		t.Fatalf("ListMetadataWithModTimeHavingFrontmatterFields() error: %v", err)
	}
	if len(felts) != 1 {
		t.Fatalf("filtered list returned %d felts, want 1: %#v", len(felts), felts)
	}
	if felts[0].ID != "with-shuttle" {
		t.Fatalf("filtered list ID = %q, want with-shuttle", felts[0].ID)
	}
	if felts[0].Body != "" {
		t.Fatalf("filtered metadata list hydrated body: %q", felts[0].Body)
	}
	if felts[0].ModifiedAt.IsZero() {
		t.Fatal("ModifiedAt should be populated when explicitly requested")
	}
	if felts[0].Path == "" {
		t.Fatal("Path should be populated for filtered metadata listings")
	}
	if _, ok := felts[0].ExtraFields["shuttle"]; !ok {
		t.Fatal("filtered list should preserve matching extra frontmatter")
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

func TestStorageFindMetadataExactIDAvoidsStoreWalk(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	f := &Felt{
		ID:        "project/task",
		Name:      "Task",
		Status:    StatusOpen,
		CreatedAt: time.Now(),
		Outcome:   "Direct lookup survives blocked siblings.",
		Body:      "Body should be skipped.",
	}
	if err := s.Write(f); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	found, ok, err := s.findExistingPathWithModeAndScope("", "project/task", ParseMetadataOnly)
	if err != nil || !ok {
		t.Fatalf("findExistingPathWithModeAndScope() = ok %v, err %v; want direct hit", ok, err)
	}
	if found.ID != f.ID {
		t.Fatalf("ID = %q, want %q", found.ID, f.ID)
	}
	if found.Body != "" {
		t.Fatalf("Body = %q, want empty", found.Body)
	}
}

func TestStorageFindMetadataFastPathPreservesScopedBasenameOrder(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	now := time.Now()
	for _, f := range []*Felt{
		{ID: "task", Name: "Root Task", CreatedAt: now},
		{ID: "project/task", Name: "Project Task", CreatedAt: now},
		{ID: "project/sub/task", Name: "Scoped Task", CreatedAt: now},
	} {
		if err := s.Write(f); err != nil {
			t.Fatalf("Write(%s) error: %v", f.ID, err)
		}
	}

	found, ok, err := s.findExistingPathWithModeAndScope("project/sub/note", "task", ParseMetadataOnly)
	if err != nil || !ok {
		t.Fatalf("findExistingPathWithModeAndScope() = ok %v, err %v; want scoped hit", ok, err)
	}
	if found.ID != "project/sub/task" {
		t.Fatalf("ID = %q, want project/sub/task", found.ID)
	}
}

func TestStorageFindMetadataFastPathRejectsParentTraversal(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(filepath.Join(dir, "project"))
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	outside := NewStorage(dir)
	if err := outside.Init(); err != nil {
		t.Fatalf("outside Init() error: %v", err)
	}
	if err := outside.Write(&Felt{
		ID:        "secret",
		Name:      "Secret",
		CreatedAt: time.Now(),
	}); err != nil {
		t.Fatalf("outside Write() error: %v", err)
	}

	if found, ok, err := s.findExistingPathWithModeAndScope("", "../secret", ParseMetadataOnly); err != nil || ok || found != nil {
		t.Fatalf("parent traversal fast path = found %#v, ok %v, err %v; want miss", found, ok, err)
	}
}

func TestReadFrontmatter(t *testing.T) {
	content := strings.NewReader(`---
name: Test Task
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
	if !strings.Contains(got, "name: Test Task") {
		t.Errorf("frontmatter = %q, want name", got)
	}
	if strings.Contains(got, "Body should never be read.") {
		t.Errorf("frontmatter = %q, should not include body", got)
	}
}

func TestReadFrontmatterRespectsBlockScalarMarkers(t *testing.T) {
	content := strings.NewReader(`---
name: Standing Inbox
outcome: |-
  first run
  ---
  second run
shuttle:
  enabled: true
tempered: true
---

Body should never be read.
`)

	frontmatter, err := readFrontmatter(content)
	if err != nil {
		t.Fatalf("readFrontmatter() error: %v", err)
	}

	got := string(frontmatter)
	for _, want := range []string{"  ---", "shuttle:", "tempered: true"} {
		if !strings.Contains(got, want) {
			t.Fatalf("frontmatter = %q, want %q", got, want)
		}
	}
	if strings.Contains(got, "Body should never be read.") {
		t.Errorf("frontmatter = %q, should not include body", got)
	}
}

func TestFrontmatterHasTopLevelFields(t *testing.T) {
	frontmatter := []byte(`name: Test
status: active
shuttle:
  enabled: true
"quoted-key": value
`)
	if !frontmatterHasTopLevelFields(frontmatter, []string{"name", "shuttle", "quoted-key"}) {
		t.Fatal("expected top-level fields to match")
	}
	if frontmatterHasTopLevelFields(frontmatter, []string{"enabled"}) {
		t.Fatal("nested field should not match as top-level")
	}
	if frontmatterHasTopLevelFields(frontmatter, []string{"missing"}) {
		t.Fatal("missing field should not match")
	}
}

func TestFrontmatterHasTopLevelFieldsAfterBlockScalarMarker(t *testing.T) {
	frontmatter := []byte(`name: Standing Inbox
outcome: |-
  first run
  ---
  second run
shuttle:
  enabled: true
tempered: true
`)
	if !frontmatterHasTopLevelFields(frontmatter, []string{"name", "outcome", "shuttle", "tempered"}) {
		t.Fatal("expected top-level fields after block scalar marker to match")
	}
	if frontmatterHasTopLevelFields(frontmatter, []string{"enabled"}) {
		t.Fatal("nested field should not match as top-level")
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

func TestStorageFindByUID(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	f1, _ := New("alpha-task", "Alpha task")
	f2, _ := New("nested/beta-task", "Beta task")
	s.Write(f1)
	s.Write(f2)

	// Resolve a top-level fiber by its exact UID.
	found, err := s.Find(f1.UID)
	if err != nil {
		t.Fatalf("Find(uid) error: %v", err)
	}
	if found.ID != f1.ID || found.UID != f1.UID {
		t.Errorf("Find(uid) = %q/%q, want %q/%q", found.ID, found.UID, f1.ID, f1.UID)
	}

	// Resolve a nested fiber by UID without needing its scope/path.
	found, err = s.Find(f2.UID)
	if err != nil {
		t.Fatalf("Find(nested uid) error: %v", err)
	}
	if found.ID != f2.ID {
		t.Errorf("Find(nested uid) = %q, want %q", found.ID, f2.ID)
	}

	// UID resolution is case-insensitive.
	found, err = s.Find(strings.ToLower(f1.UID))
	if err != nil {
		t.Fatalf("Find(lowercase uid) error: %v", err)
	}
	if found.ID != f1.ID {
		t.Errorf("Find(lowercase uid) = %q, want %q", found.ID, f1.ID)
	}

	// A UID-shaped query that matches nothing still errors cleanly.
	if _, err := s.Find(NewULID()); err == nil {
		t.Error("Find(unknown uid) should error")
	}
}

func TestLooksLikeUID(t *testing.T) {
	if !LooksLikeUID(NewULID()) {
		t.Error("LooksLikeUID(NewULID()) = false, want true")
	}
	for _, q := range []string{"", "alpha-task", "ai-futures/shuttle", "01KVH4SJCD3C9XAGDDXJ9F6SR"} {
		if LooksLikeUID(q) {
			t.Errorf("LooksLikeUID(%q) = true, want false", q)
		}
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

func TestResolveAddPath(t *testing.T) {
	tests := []struct {
		name          string
		slug          string
		existing      []string
		wantResolved  string
		wantRewritten bool
		wantErrSubstr string
	}{
		{
			name:          "no slash leaves slug at top level",
			slug:          "fresh-fiber",
			existing:      []string{"project/launch-cluster"},
			wantResolved:  "fresh-fiber",
			wantRewritten: false,
		},
		{
			name:          "leading segment missing from tree leaves slug as-is",
			slug:          "novel-root/child",
			existing:      []string{"project/launch-cluster", "other/thing"},
			wantResolved:  "novel-root/child",
			wantRewritten: false,
		},
		{
			name:          "single nested match resolves under that parent",
			slug:          "launch-cluster/dogfood",
			existing:      []string{"lightcone/paper2astra-as-skill/launch-cluster"},
			wantResolved:  "lightcone/paper2astra-as-skill/launch-cluster/dogfood",
			wantRewritten: true,
		},
		{
			name:          "top-level only match leaves slug unchanged",
			slug:          "launch-cluster/dogfood",
			existing:      []string{"launch-cluster"},
			wantResolved:  "launch-cluster/dogfood",
			wantRewritten: false,
		},
		{
			name:          "fully-qualified slug under existing root is left alone",
			slug:          "lightcone/paper/launch-cluster/dogfood",
			existing:      []string{"lightcone", "lightcone/paper/launch-cluster"},
			wantResolved:  "lightcone/paper/launch-cluster/dogfood",
			wantRewritten: false,
		},
		{
			name: "ambiguous nested matches return an error listing candidates",
			slug: "launch-cluster/dogfood",
			existing: []string{
				"lightcone/paper2astra-as-skill/launch-cluster",
				"other-project/launch-cluster",
			},
			wantErrSubstr: "could resolve to multiple existing locations",
		},
		{
			name: "top-level coexisting with nested resolves to top-level (input matches)",
			slug: "launch-cluster/dogfood",
			existing: []string{
				"launch-cluster",
				"other-project/launch-cluster",
			},
			wantResolved:  "launch-cluster/dogfood",
			wantRewritten: false,
		},
		{
			name:          "deep slug under single match keeps the tail",
			slug:          "launch-cluster/notes/quick",
			existing:      []string{"lightcone/paper/launch-cluster"},
			wantResolved:  "lightcone/paper/launch-cluster/notes/quick",
			wantRewritten: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resolved, rewritten, err := ResolveAddPath(tt.slug, tt.existing)
			if tt.wantErrSubstr != "" {
				if err == nil {
					t.Fatalf("ResolveAddPath(%q) = (%q, %v, nil), want error containing %q", tt.slug, resolved, rewritten, tt.wantErrSubstr)
				}
				if !strings.Contains(err.Error(), tt.wantErrSubstr) {
					t.Fatalf("ResolveAddPath(%q) error = %q, want substring %q", tt.slug, err.Error(), tt.wantErrSubstr)
				}
				return
			}
			if err != nil {
				t.Fatalf("ResolveAddPath(%q) error: %v", tt.slug, err)
			}
			if resolved != tt.wantResolved {
				t.Fatalf("ResolveAddPath(%q) resolved = %q, want %q", tt.slug, resolved, tt.wantResolved)
			}
			if rewritten != tt.wantRewritten {
				t.Fatalf("ResolveAddPath(%q) rewritten = %v, want %v", tt.slug, rewritten, tt.wantRewritten)
			}
		})
	}
}

// TestResolveAddPathAmbiguityListsAllCandidates pins the exact candidate
// strings in the ambiguity message so users can pick the fully-qualified
// path they meant without re-running felt ls.
func TestResolveAddPathAmbiguityListsAllCandidates(t *testing.T) {
	_, _, err := ResolveAddPath("launch-cluster/dogfood", []string{
		"other-project/launch-cluster",
		"lightcone/paper2astra-as-skill/launch-cluster",
	})
	if err == nil {
		t.Fatal("expected ambiguity error")
	}
	for _, want := range []string{
		"lightcone/paper2astra-as-skill/launch-cluster/dogfood",
		"other-project/launch-cluster/dogfood",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("ambiguity error missing candidate %q: %s", want, err.Error())
		}
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

func TestResolveScopedIDPrefersExactBasenameOverPrefix(t *testing.T) {
	// When a query matches one fiber exactly and others by prefix, the exact match wins.
	ids := []string{
		"project/status",
		"project/status-encoding-color-fog",
		"project/status-model-tasks-vs-knowledge",
	}

	got, err := ResolveScopedID(ids, "project/analysis/strip-dead", "status")
	if err != nil {
		t.Fatalf("ResolveScopedID() error: %v (should prefer exact match)", err)
	}
	if got != "project/status" {
		t.Fatalf("ResolveScopedID() = %q, want %q", got, "project/status")
	}
}

func TestResolveScopedIDPrefersExactPathOverDescendants(t *testing.T) {
	// A slash-path to a parent fiber must resolve even though that parent has
	// children whose ids share its prefix (the children must not defeat it
	// into a spurious ambiguity error).
	ids := []string{
		"project/design/kanban",
		"project/design/kanban/drift-test",
		"project/design/kanban/property-test",
	}

	got, err := ResolveScopedID(ids, "project/design/kanban/drift-test", "design/kanban")
	if err != nil {
		t.Fatalf("ResolveScopedID() error: %v (parent with children should resolve)", err)
	}
	if got != "project/design/kanban" {
		t.Fatalf("ResolveScopedID() = %q, want %q", got, "project/design/kanban")
	}
}

func TestResolveScopedIDGlobalUniqueBasenameFallback(t *testing.T) {
	// A globally-unique slug resolves from a scope that cannot reach it by
	// walking up — e.g. a cross-project link in the aggregated monorepo.
	ids := []string{
		"alpha/notes/setup",
		"beta/deploy/runbook",
	}

	got, err := ResolveScopedID(ids, "alpha/notes/setup", "runbook")
	if err != nil {
		t.Fatalf("ResolveScopedID() error: %v (unique slug should resolve globally)", err)
	}
	if got != "beta/deploy/runbook" {
		t.Fatalf("ResolveScopedID() = %q, want %q", got, "beta/deploy/runbook")
	}

	// A non-unique slug must NOT resolve via the fallback.
	ids = append(ids, "gamma/deploy/runbook")
	if got, err := ResolveScopedID(ids, "alpha/notes/setup", "runbook"); err == nil {
		t.Fatalf("expected no resolution for non-unique slug, got %q", got)
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
	child := &Felt{ID: "damping-prior", Name: "Damping Prior", CreatedAt: time.Now()}
	mustExtraField(t, child, "inputs", []map[string]any{{"id": "analysis_input", "from": "bao-analysis.posterior"}})
	grandchild := &Felt{ID: "damping-prior/contour-plot", Name: "Contour Plot", CreatedAt: time.Now()}
	mustExtraField(t, grandchild, "inputs", []map[string]any{{"id": "plot_input", "from": "damping-prior.fit"}})
	consumer := &Felt{ID: "consumer", Name: "Consumer", CreatedAt: time.Now()}
	mustExtraField(t, consumer, "inputs", []map[string]any{{"id": "consumer_input", "from": "damping-prior/contour-plot.figure"}})

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
	if got := moved.DataFlowInputs()[0].From; got != "bao-analysis.posterior" {
		t.Fatalf("moved child input = %q, want %q", got, "bao-analysis.posterior")
	}

	descendant, err := s.Read("bao-analysis/damping-prior/contour-plot")
	if err != nil {
		t.Fatalf("Read moved descendant: %v", err)
	}
	if got := descendant.DataFlowInputs()[0].From; got != "bao-analysis/damping-prior.fit" {
		t.Fatalf("moved descendant input = %q, want %q", got, "bao-analysis/damping-prior.fit")
	}

	updatedConsumer, err := s.Read("consumer")
	if err != nil {
		t.Fatalf("Read consumer: %v", err)
	}
	if got := updatedConsumer.DataFlowInputs()[0].From; got != "bao-analysis/damping-prior/contour-plot.figure" {
		t.Fatalf("consumer input = %q, want rewritten descendant ref", got)
	}
}

func TestStorageMoveSubtreePreservesLooseArtifacts(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	for _, f := range []*Felt{
		{ID: "bao-analysis", Name: "BAO Analysis", CreatedAt: time.Now()},
		{ID: "damping-prior", Name: "Damping Prior", CreatedAt: time.Now()},
		{ID: "damping-prior/contour-plot", Name: "Contour Plot", CreatedAt: time.Now()},
	} {
		if err := s.Write(f); err != nil {
			t.Fatalf("Write(%s) error: %v", f.ID, err)
		}
	}

	artifacts := map[string]string{
		filepath.Join("damping-prior", "plot.png"):                   "png bytes",
		filepath.Join("damping-prior", "report.html"):                "<html>report</html>",
		filepath.Join("damping-prior", "contour-plot", "stats.json"): `{"ok":true}`,
	}
	for rel, contents := range artifacts {
		artifactPath := filepath.Join(s.root, rel)
		if err := os.WriteFile(artifactPath, []byte(contents), 0644); err != nil {
			t.Fatalf("WriteFile(%s) error: %v", artifactPath, err)
		}
	}

	if err := s.MoveSubtree("damping-prior", "bao-analysis/damping-prior"); err != nil {
		t.Fatalf("MoveSubtree() error: %v", err)
	}

	for rel, contents := range artifacts {
		oldPath := filepath.Join(s.root, rel)
		if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
			t.Fatalf("old artifact %s still exists or stat failed: %v", oldPath, err)
		}

		newPath := filepath.Join(s.root, "bao-analysis", rel)
		data, err := os.ReadFile(newPath)
		if err != nil {
			t.Fatalf("ReadFile(%s) error: %v", newPath, err)
		}
		if string(data) != contents {
			t.Fatalf("artifact %s = %q, want %q", newPath, string(data), contents)
		}
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
	if got := migrated.DataFlowInputs()[0].From; got != "bao-analysis.posterior" {
		t.Fatalf("input rewrite = %q, want %q", got, "bao-analysis.posterior")
	}
	if migrated.Body != "Quick note." {
		t.Fatalf("migrated body should preserve plain markdown body, got %q", migrated.Body)
	}
}

func TestStorageBackfillIntrinsicIDs(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	missing := `---
name: Missing ID
created-at: 2026-03-15T10:00:00Z
shuttle:
  enabled: true
---

Body.
`
	existingID := "01JZ0000000000000000000000"
	existing := `---
id: 01JZ0000000000000000000000
name: Existing ID
created-at: 2026-03-16T10:00:00Z
---

Already identified.
`
	if err := os.MkdirAll(filepath.Join(s.root, "missing-id"), 0755); err != nil {
		t.Fatalf("mkdir missing-id: %v", err)
	}
	if err := os.WriteFile(filepath.Join(s.root, "missing-id", "missing-id.md"), []byte(missing), 0644); err != nil {
		t.Fatalf("write missing: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(s.root, "existing-id"), 0755); err != nil {
		t.Fatalf("mkdir existing-id: %v", err)
	}
	if err := os.WriteFile(filepath.Join(s.root, "existing-id", "existing-id.md"), []byte(existing), 0644); err != nil {
		t.Fatalf("write existing: %v", err)
	}

	dryRun, err := s.BackfillIntrinsicIDs(true)
	if err != nil {
		t.Fatalf("BackfillIntrinsicIDs(dryRun) error: %v", err)
	}
	if !reflect.DeepEqual(dryRun.AssignedIDs, []string{"missing-id"}) {
		t.Fatalf("dry-run assigned ids = %#v", dryRun.AssignedIDs)
	}
	data, err := os.ReadFile(filepath.Join(s.root, "missing-id", "missing-id.md"))
	if err != nil {
		t.Fatalf("read missing after dry-run: %v", err)
	}
	if strings.Contains(string(data), "\nid: ") {
		t.Fatalf("dry-run wrote id:\n%s", string(data))
	}

	applied, err := s.BackfillIntrinsicIDs(false)
	if err != nil {
		t.Fatalf("BackfillIntrinsicIDs() error: %v", err)
	}
	if !reflect.DeepEqual(applied.AssignedIDs, []string{"missing-id"}) {
		t.Fatalf("applied assigned ids = %#v", applied.AssignedIDs)
	}
	backfilled, err := s.Read("missing-id")
	if err != nil {
		t.Fatalf("Read missing-id: %v", err)
	}
	if !looksLikeULID(backfilled.UID) {
		t.Fatalf("backfilled UID = %q, want ULID", backfilled.UID)
	}
	if backfilled.Body != "Body." {
		t.Fatalf("backfilled body = %q, want Body.", backfilled.Body)
	}
	kept, err := s.Read("existing-id")
	if err != nil {
		t.Fatalf("Read existing-id: %v", err)
	}
	if kept.UID != existingID {
		t.Fatalf("existing UID = %q, want %q", kept.UID, existingID)
	}

	again, err := s.BackfillIntrinsicIDs(false)
	if err != nil {
		t.Fatalf("BackfillIntrinsicIDs() again error: %v", err)
	}
	if len(again.AssignedIDs) != 0 {
		t.Fatalf("second backfill should be idempotent, got %#v", again.AssignedIDs)
	}
}

func TestStorageBackfillIntrinsicIDsSkipsNonFiberMarkdown(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	if err := os.WriteFile(filepath.Join(s.root, "README.md"), []byte("not frontmatter\n"), 0644); err != nil {
		t.Fatalf("write sidecar: %v", err)
	}

	result, err := s.BackfillIntrinsicIDs(true)
	if err != nil {
		t.Fatalf("BackfillIntrinsicIDs() should skip non-fiber markdown, got: %v", err)
	}
	if len(result.AssignedIDs) != 0 {
		t.Fatalf("assigned ids = %#v, want none", result.AssignedIDs)
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
	// Two bare files are legacy; migrate moves both.
	if err := os.WriteFile(filepath.Join(s.root, "quick-gotcha-deadbeef.md"), []byte(legacy), 0644); err != nil {
		t.Fatalf("write legacy: %v", err)
	}
	if err := os.WriteFile(filepath.Join(s.root, "other-note-cafe0001.md"), []byte(legacy), 0644); err != nil {
		t.Fatalf("write legacy 2: %v", err)
	}

	result, err := s.MigrateFlatFiles(true)
	if err != nil {
		t.Fatalf("MigrateFlatFiles(true) error: %v", err)
	}
	if len(result.Entries) != 2 {
		t.Fatalf("dry-run entries = %#v, want 2", result.Entries)
	}
	if _, err := os.Stat(filepath.Join(s.root, "quick-gotcha-deadbeef.md")); err != nil {
		t.Fatalf("dry-run should keep legacy file: %v", err)
	}
	if _, err := os.Stat(filepath.Join(s.root, "quick-gotcha", "quick-gotcha.md")); !os.IsNotExist(err) {
		t.Fatalf("dry-run should not create migrated directory, err=%v", err)
	}
}

func TestStorageMigrateSingleBareFilePreservedAsEntryPoint(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	// A single bare .md at .felt/ root is the entry-point fiber (the shape
	// a project's root fiber takes when its `.felt/` is mounted into an
	// outer monorepo via symlink). Do not migrate it.
	entry := `---
name: Project root
---

Root narrative.
`
	if err := os.WriteFile(filepath.Join(s.root, "cmbx.md"), []byte(entry), 0644); err != nil {
		t.Fatalf("write entry: %v", err)
	}

	result, err := s.MigrateFlatFiles(false)
	if err != nil {
		t.Fatalf("MigrateFlatFiles: %v", err)
	}
	if len(result.Entries) != 0 {
		t.Fatalf("entries = %+v, want none (single bare root preserved)", result.Entries)
	}
	if _, err := os.Stat(filepath.Join(s.root, "cmbx.md")); err != nil {
		t.Fatalf("bare root should be preserved: %v", err)
	}
	if _, err := os.Stat(filepath.Join(s.root, "cmbx", "cmbx.md")); !os.IsNotExist(err) {
		t.Fatalf("should not have migrated bare root to dir form, err=%v", err)
	}
}

func TestStorageMigrateRewritesPreExistingDirectoryInputs(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	// Flat files that will be migrated (two so migration runs — a single bare
	// file would be preserved as the entry-point fiber).
	legacy := `---
title: BAO Analysis
created-at: 2026-03-16T10:00:00Z
---

Analysis body.
`
	if err := os.WriteFile(filepath.Join(s.root, "bao-analysis-d34db33f.md"), []byte(legacy), 0644); err != nil {
		t.Fatalf("write legacy: %v", err)
	}
	if err := os.WriteFile(filepath.Join(s.root, "other-note-cafe0002.md"), []byte(legacy), 0644); err != nil {
		t.Fatalf("write legacy 2: %v", err)
	}

	// Pre-existing directory fiber with a stale hex input ref
	preExisting := &Felt{
		ID:        "session-hub",
		Name:      "Session hub",
		CreatedAt: time.Now(),
		Body:      "(session-hub)=\n# Session hub",
	}
	mustExtraField(t, preExisting, "inputs", []map[string]any{{"id": "analysis_input", "from": "bao-analysis-d34db33f.posterior"}})
	if err := s.Write(preExisting); err != nil {
		t.Fatalf("write pre-existing: %v", err)
	}

	result, err := s.MigrateFlatFiles(false)
	if err != nil {
		t.Fatalf("MigrateFlatFiles() error: %v", err)
	}
	if len(result.Entries) != 2 {
		t.Fatalf("expected 2 migration entries, got %d", len(result.Entries))
	}

	// The pre-existing directory fiber should have its input ref rewritten
	hub, err := s.Read("session-hub")
	if err != nil {
		t.Fatalf("Read session-hub: %v", err)
	}
	if got := hub.DataFlowInputs()[0].From; got != "bao-analysis.posterior" {
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
depends-on:
  - legacy-parent
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
	if got, want := result.RemovedDependsOnIDs, []string{"session-hub"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("RemovedDependsOnIDs = %#v, want %#v", got, want)
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
	if strings.Contains(text, "depends-on:") {
		t.Fatalf("migrate should strip legacy depends-on field:\n%s", text)
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
depends-on:
  - legacy-parent
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
	if got, want := result.RemovedDependsOnIDs, []string{"session-hub"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("RemovedDependsOnIDs = %#v, want %#v", got, want)
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

func TestStorageBareRootFiber(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	// Write a bare top-level fiber at .felt/cmbx.md — the entry-point shape,
	// equivalent to <project>/<project>.md when the project's `.felt/` is
	// mounted into an outer monorepo via symlink.
	bare := filepath.Join(s.root, "cmbx.md")
	body := "---\nname: cmbx\nstatus: active\n---\n\nRoot narrative.\n"
	if err := os.WriteFile(bare, []byte(body), 0644); err != nil {
		t.Fatalf("write bare root: %v", err)
	}

	// Path should resolve to the bare form when the bare file exists.
	if got := s.Path("cmbx"); got != bare {
		t.Errorf("Path(cmbx) = %q, want %q", got, bare)
	}

	// List should include the bare fiber.
	felts, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(felts) != 1 || felts[0].ID != "cmbx" {
		t.Fatalf("List = %+v, want single fiber cmbx", felts)
	}

	// Find by id should resolve.
	f, err := s.Find("cmbx")
	if err != nil {
		t.Fatalf("Find: %v", err)
	}
	if f.Name != "cmbx" {
		t.Errorf("Find(cmbx).Name = %q, want cmbx", f.Name)
	}
}

func TestStoragePathFallsBackToDirectoryForm(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	// No file exists yet — Path returns the directory form for a top-level id.
	got := s.Path("cmbx")
	want := filepath.Join(s.root, "cmbx", "cmbx.md")
	if got != want {
		t.Errorf("Path(cmbx) with no file = %q, want %q", got, want)
	}
}

func TestStoragePathBareWithNestedChild(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	// Bare root + a nested child. List should return both, each with the right id.
	bare := filepath.Join(s.root, "cmbx.md")
	os.WriteFile(bare, []byte("---\nname: cmbx\n---\n"), 0644)
	childDir := filepath.Join(s.root, "cmbx-meeting", "cmbx-meeting")
	os.MkdirAll(filepath.Dir(childDir), 0755)
	os.WriteFile(childDir+".md", []byte("---\nname: child\n---\n"), 0644)

	felts, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	ids := map[string]bool{}
	for _, f := range felts {
		ids[f.ID] = true
	}
	if !ids["cmbx"] || !ids["cmbx-meeting"] {
		t.Errorf("List ids = %v, want both cmbx and cmbx-meeting", ids)
	}
}

// TestStorageListSymlinkedSubstoreLiftsIds models a felt store that mounts
// another store via a symlinked subdirectory whose target lives outside the
// outer tree. Fibers under the mount must surface with ids rooted in the
// outer namespace (`<symlink-name>/<inner-id>`), not the leaked `../../...`
// traversal that `filepath.Rel(outerRoot, resolvedAbsPath)` would yield.
func TestStorageListSymlinkedSubstoreLiftsIds(t *testing.T) {
	tmp := t.TempDir()

	// Outer store: has its own root fiber so we can confirm the rest of
	// the walk still works after the symlink is in place.
	outerProj := filepath.Join(tmp, "outer")
	outerS := NewStorage(outerProj)
	if err := outerS.Init(); err != nil {
		t.Fatalf("outer init: %v", err)
	}
	rootMd := filepath.Join(outerS.root, "outer.md")
	if err := os.WriteFile(rootMd, []byte("---\nname: outer\n---\n"), 0644); err != nil {
		t.Fatalf("write outer root: %v", err)
	}

	// Inner store: lives entirely outside outer's tree. One fiber inside,
	// in a deeply-nested directory shape — the layout that broke before
	// the fix.
	innerProj := filepath.Join(tmp, "inner-elsewhere")
	innerS := NewStorage(innerProj)
	if err := innerS.Init(); err != nil {
		t.Fatalf("inner init: %v", err)
	}
	deepDir := filepath.Join(innerS.root, "section", "subsection", "leaf")
	if err := os.MkdirAll(deepDir, 0755); err != nil {
		t.Fatalf("mkdir deep: %v", err)
	}
	deepMd := filepath.Join(deepDir, "leaf.md")
	if err := os.WriteFile(deepMd, []byte("---\nname: leaf\n---\n"), 0644); err != nil {
		t.Fatalf("write deep: %v", err)
	}

	// Mount inner under outer via a symlinked subdirectory.
	mountAt := filepath.Join(outerS.root, "mounts", "guest")
	if err := os.MkdirAll(filepath.Dir(mountAt), 0755); err != nil {
		t.Fatalf("mkdir mount parent: %v", err)
	}
	if err := os.Symlink(innerS.root, mountAt); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	felts, err := outerS.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	got := map[string]bool{}
	for _, f := range felts {
		got[f.ID] = true
	}

	wantInnerID := "mounts/guest/section/subsection/leaf"
	if !got[wantInnerID] {
		t.Errorf("expected inner id %q under outer namespace; got ids = %v", wantInnerID, got)
	}
	for id := range got {
		if strings.Contains(id, "..") {
			t.Errorf("id %q contains traversal ('..') — symlink target leaked", id)
		}
		if strings.Contains(id, ".felt") {
			t.Errorf("id %q contains '.felt' segment — internal path leaked", id)
		}
	}
	if !got["outer"] {
		t.Errorf("outer root fiber missing from list; got %v", got)
	}
}

// TestStorageListSymlinkedFeltDirIntoOuter models a monorepo arrangement
// where a project's `.felt/` is itself a symlink into a subdirectory of an
// outer store's `.felt/`. The project view should see project-relative ids
// (root fiber surfaces as the bare entry-point); the outer view should see
// the same fibers under directory-form ids one tier higher. Both directions
// must produce clean, `..`-free ids and agree on identity (the same files
// surface in both, just under different namespaces).
func TestStorageListSymlinkedFeltDirIntoOuter(t *testing.T) {
	tmp := t.TempDir()

	// Outer monorepo store with a project's content nested inside it.
	outerS := NewStorage(filepath.Join(tmp, "monorepo"))
	if err := outerS.Init(); err != nil {
		t.Fatalf("outer init: %v", err)
	}
	projectDir := filepath.Join(outerS.root, "projects", "alpha")
	if err := os.MkdirAll(projectDir, 0755); err != nil {
		t.Fatalf("mkdir project: %v", err)
	}
	// Project root fiber. From inside the project (via the symlink set up
	// below), `.felt/alpha.md` is the bare entry-point shape. From the
	// outer view, the same file at `<.felt>/projects/alpha/alpha.md`
	// reads as the directory-form fiber `projects/alpha` — its parent
	// dir name matches the slug, so the existing fiberIDFromRelativePath
	// shape rule treats it as a directory-form fiber, not a bare-at-depth.
	if err := os.WriteFile(filepath.Join(projectDir, "alpha.md"), []byte("---\nname: alpha\n---\n"), 0644); err != nil {
		t.Fatalf("write project root: %v", err)
	}
	// One nested fiber inside the project subtree.
	nestedDir := filepath.Join(projectDir, "feature")
	if err := os.MkdirAll(nestedDir, 0755); err != nil {
		t.Fatalf("mkdir nested: %v", err)
	}
	if err := os.WriteFile(filepath.Join(nestedDir, "feature.md"), []byte("---\nname: feature\n---\n"), 0644); err != nil {
		t.Fatalf("write nested: %v", err)
	}

	// Project view: the project's `.felt/` is a symlink into the outer
	// store's project subtree. felt walks should treat the symlink target
	// as the project's logical `.felt/` root, surfacing only project
	// fibers with project-relative ids.
	projectProj := filepath.Join(tmp, "alpha-checkout")
	if err := os.MkdirAll(projectProj, 0755); err != nil {
		t.Fatalf("mkdir project checkout: %v", err)
	}
	projectFelt := filepath.Join(projectProj, ".felt")
	if err := os.Symlink(projectDir, projectFelt); err != nil {
		t.Fatalf("project felt symlink: %v", err)
	}
	projectS := NewStorage(projectProj)

	projectFelts, err := projectS.List()
	if err != nil {
		t.Fatalf("project List: %v", err)
	}
	projectIDs := map[string]bool{}
	for _, f := range projectFelts {
		projectIDs[f.ID] = true
	}
	if !projectIDs["alpha"] {
		t.Errorf("project view: expected entry-point id %q; got %v", "alpha", projectIDs)
	}
	if !projectIDs["feature"] {
		t.Errorf("project view: expected nested id %q; got %v", "feature", projectIDs)
	}
	for id := range projectIDs {
		if strings.Contains(id, "..") || strings.Contains(id, ".felt") {
			t.Errorf("project view id %q contains traversal/internal-path leak", id)
		}
	}

	// Outer view: the same files surface as directory-form fibers one tier
	// up. `<.felt>/projects/alpha/alpha.md` reads as id `projects/alpha`;
	// `<.felt>/projects/alpha/feature/feature.md` reads as `projects/alpha/feature`.
	outerFelts, err := outerS.List()
	if err != nil {
		t.Fatalf("outer List: %v", err)
	}
	outerIDs := map[string]bool{}
	for _, f := range outerFelts {
		outerIDs[f.ID] = true
	}
	if !outerIDs["projects/alpha"] {
		t.Errorf("outer view: expected %q; got %v", "projects/alpha", outerIDs)
	}
	if !outerIDs["projects/alpha/feature"] {
		t.Errorf("outer view: expected %q; got %v", "projects/alpha/feature", outerIDs)
	}
	for id := range outerIDs {
		if strings.Contains(id, "..") || strings.Contains(id, ".felt") {
			t.Errorf("outer view id %q contains traversal/internal-path leak", id)
		}
	}
}
