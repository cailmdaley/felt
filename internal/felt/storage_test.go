package felt

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

func TestNewStorage(t *testing.T) {
	t.Parallel()
	s := NewStorage("/tmp/test-project")
	if s.root != "/tmp/test-project/.felt" {
		t.Errorf("root = %q, want %q", s.root, "/tmp/test-project/.felt")
	}
}

func TestFindMetadataWithoutGuessingUsesTypedNotFound(t *testing.T) {
	t.Parallel()
	storage := NewStorage(t.TempDir())
	if err := storage.Init(); err != nil {
		t.Fatal(err)
	}

	_, err := storage.FindMetadataWithoutGuessing("", "missing")
	var missing *NoFiberMatchError
	if !errors.As(err, &missing) || missing.Query != "missing" {
		t.Fatalf("not-found error = %v, want typed NoFiberMatchError", err)
	}
}

func TestStorageInit(t *testing.T) {
	t.Parallel()
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
	if _, err := os.Stat(filepath.Join(s.root, LegacyMystConfigName)); !os.IsNotExist(err) {
		t.Fatalf("Init() must not create %s; felt is not a MyST project", LegacyMystConfigName)
	}
	gitignoreData, err := os.ReadFile(filepath.Join(s.root, GitignoreName))
	if err != nil {
		t.Fatalf("reading .gitignore: %v", err)
	}
	if string(gitignoreData) != defaultGitignore {
		t.Fatalf(".gitignore = %q, want default ignore", string(gitignoreData))
	}
	if !strings.Contains(string(gitignoreData), "*.md.lock") {
		t.Fatalf(".gitignore missing lock-sidecar ignore: %q", string(gitignoreData))
	}

	// Init again should work (idempotent)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() second call error: %v", err)
	}
}

func TestStorageInitCreatesGitignoreInExistingDirectory(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	feltDir := filepath.Join(dir, DirName)
	if err := os.MkdirAll(feltDir, 0755); err != nil {
		t.Fatalf("MkdirAll() error: %v", err)
	}

	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	if _, err := os.Stat(filepath.Join(feltDir, GitignoreName)); err != nil {
		t.Fatalf(".gitignore should be created in existing .felt/: %v", err)
	}
}

func TestStorageInitDoesNotOverwriteExistingGitignore(t *testing.T) {
	t.Parallel()
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
	t.Parallel()
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
	mustExtra(t, f, "inputs", []map[string]any{{"id": "dep_a", "from": "dep-a.output"}})

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
	t.Parallel()
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	_, err := s.Read("nonexistent")
	if err == nil {
		t.Error("Read() should error for non-existent file")
	}
}

func TestStorageDelete(t *testing.T) {
	t.Parallel()
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
	t.Parallel()
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	err := s.Delete("nonexistent")
	if err == nil {
		t.Error("Delete() should error for non-existent file")
	}
}

func TestStorageList(t *testing.T) {
	t.Parallel()
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

func TestStorageListMetadataSkipsBody(t *testing.T) {
	t.Parallel()
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
	t.Parallel()
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
	t.Parallel()
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
	t.Parallel()
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

	found, err := s.FindMetadataInScope("", "test")
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
	t.Parallel()
	_, s := newStore(t)

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
	t.Parallel()
	_, s := newStore(t)

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
	t.Parallel()
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
	t.Parallel()
	content := []byte(`---
name: Test Task
status: open
created-at: 2026-01-01T10:00:00Z
---

Body should never be read.
`)

	frontmatter, _, err := SplitFrontmatter(content, false)
	if err != nil {
		t.Fatalf("SplitFrontmatter() error: %v", err)
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
	t.Parallel()
	content := []byte(`---
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

	frontmatter, _, err := SplitFrontmatter(content, false)
	if err != nil {
		t.Fatalf("SplitFrontmatter() error: %v", err)
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
	t.Parallel()
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
	t.Parallel()
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
	t.Parallel()
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
			_, _, err := SplitFrontmatter([]byte(tt.content), false)
			if err == nil {
				t.Fatalf("SplitFrontmatter() error = nil, want error")
			}
		})
	}
}

func TestStorageListIgnoresNonMdFiles(t *testing.T) {
	t.Parallel()
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
	t.Parallel()
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
	t.Parallel()
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	f1, _ := New("alpha-task", "Alpha task")
	f2, _ := New("beta-task", "Beta task")
	s.Write(f1)
	s.Write(f2)

	// Find by full ID
	found, err := s.FindInScope("", f1.ID)
	if err != nil {
		t.Fatalf("Find() error: %v", err)
	}
	if found.ID != f1.ID {
		t.Errorf("Found ID = %q, want %q", found.ID, f1.ID)
	}

	// Find by prefix
	found, err = s.FindInScope("", "alpha-task")
	if err != nil {
		t.Fatalf("Find() by prefix error: %v", err)
	}
	if found.ID != f1.ID {
		t.Errorf("Found by prefix ID = %q, want %q", found.ID, f1.ID)
	}
}

func TestStorageFindByUID(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	f1, _ := New("alpha-task", "Alpha task")
	f2, _ := New("nested/beta-task", "Beta task")
	s.Write(f1)
	s.Write(f2)

	// Resolve a top-level fiber by its exact UID.
	found, err := s.FindInScope("", f1.UID)
	if err != nil {
		t.Fatalf("Find(uid) error: %v", err)
	}
	if found.ID != f1.ID || found.UID != f1.UID {
		t.Errorf("Find(uid) = %q/%q, want %q/%q", found.ID, found.UID, f1.ID, f1.UID)
	}

	// Resolve a nested fiber by UID without needing its scope/path.
	found, err = s.FindInScope("", f2.UID)
	if err != nil {
		t.Fatalf("Find(nested uid) error: %v", err)
	}
	if found.ID != f2.ID {
		t.Errorf("Find(nested uid) = %q, want %q", found.ID, f2.ID)
	}

	// UID resolution is case-insensitive.
	found, err = s.FindInScope("", strings.ToLower(f1.UID))
	if err != nil {
		t.Fatalf("Find(lowercase uid) error: %v", err)
	}
	if found.ID != f1.ID {
		t.Errorf("Find(lowercase uid) = %q, want %q", found.ID, f1.ID)
	}

	// A UID-shaped query that matches nothing still errors cleanly.
	if _, err := s.FindInScope("", NewULID()); err == nil {
		t.Error("Find(unknown uid) should error")
	}
}

// TestListMetadataByUIDMatchesFrontmatterOnly: the byte prefilter that keeps
// a UID walk from parsing every fiber still answers exactly — a body that
// mentions the UID is not a match, and the case of the query does not matter.
func TestListMetadataByUIDMatchesFrontmatterOnly(t *testing.T) {
	s := NewStorage(t.TempDir())
	s.Init()

	target, _ := New("nested/target", "Target")
	mention, _ := New("mention", "Mention")
	mention.Body = "Follows up on " + target.UID + ".\n"
	s.Write(target)
	s.Write(mention)

	for _, query := range []string{target.UID, strings.ToLower(target.UID)} {
		matches, err := s.ListMetadataByUID(query)
		if err != nil {
			t.Fatalf("ListMetadataByUID(%q): %v", query, err)
		}
		if len(matches) != 1 || matches[0].ID != target.ID {
			t.Fatalf("ListMetadataByUID(%q) = %v, want only %q", query, matches, target.ID)
		}
	}
	if matches, err := s.ListMetadataByUID(NewULID()); err != nil || len(matches) != 0 {
		t.Fatalf("ListMetadataByUID(unknown) = %v, %v; want none", matches, err)
	}
}

// TestReadResolvedRescansAMovedUID: a fiber that moves between resolving its
// UID and reading it is found again by one more resolution.
func TestReadResolvedRescansAMovedUID(t *testing.T) {
	s := NewStorage(t.TempDir())
	s.Init()
	f, _ := New("before", "Moving")
	s.Write(f)

	reads := 0
	ref, got, err := ReadResolved(s, "", f.UID, func(r Ref) (*Felt, error) {
		reads++
		if reads == 1 {
			moved := s.Path("after")
			if err := os.MkdirAll(filepath.Dir(moved), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(s.Path("before"), moved); err != nil {
				t.Fatal(err)
			}
		}
		return r.Storage.FindInScope("", r.ID)
	})
	if err != nil {
		t.Fatalf("ReadResolved: %v", err)
	}
	if reads != 2 || ref.ID != "after" || got.UID != f.UID {
		t.Fatalf("ReadResolved = %q (%d reads), want %q after 2 reads", ref.ID, reads, "after")
	}
}

func TestLooksLikeUID(t *testing.T) {
	t.Parallel()
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
	t.Parallel()
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	_, err := s.FindInScope("", "nonexistent")
	if err == nil {
		t.Error("Find() should error when no match")
	}
}

func TestStorageFindAmbiguous(t *testing.T) {
	t.Parallel()
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
	_, err := s.FindInScope("", "task")
	if err == nil {
		t.Error("Find() should error when ambiguous")
	}
}

func TestStoragePath(t *testing.T) {
	t.Parallel()
	s := NewStorage("/project")
	path := s.Path("test-path")
	expected := "/project/.felt/test-path/test-path.md"
	if path != expected {
		t.Errorf("Path() = %q, want %q", path, expected)
	}
}

func TestStoragePathNested(t *testing.T) {
	t.Parallel()
	s := NewStorage("/project")
	path := s.Path("bao-analysis/damping-prior")
	expected := "/project/.felt/bao-analysis/damping-prior/damping-prior.md"
	if path != expected {
		t.Errorf("Path() = %q, want %q", path, expected)
	}
}

func TestStorageCheckAvailableID(t *testing.T) {
	t.Parallel()
	_, s := newStore(t)

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
	t.Parallel()
	_, s := newStore(t)

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
	t.Parallel()
	_, s := newStore(t)

	f := &Felt{
		ID:        "bao-analysis/damping-prior",
		Name:      "Damping Prior",
		CreatedAt: time.Now(),
	}
	if err := s.Write(f); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	if _, err := s.FindInScope("", "damping"); err == nil {
		t.Fatal("Find() without scope should not resolve nested basename")
	}
}

func TestStorageFindPrefersExactIDOverPrefix(t *testing.T) {
	t.Parallel()
	_, s := newStore(t)

	for _, f := range []*Felt{
		{ID: "bao-analysis", Name: "BAO Analysis", CreatedAt: time.Now()},
		{ID: "bao-analysis/damping-prior", Name: "Damping Prior", CreatedAt: time.Now()},
	} {
		if err := s.Write(f); err != nil {
			t.Fatalf("Write(%s) error: %v", f.ID, err)
		}
	}

	found, err := s.FindInScope("", "bao-analysis")
	if err != nil {
		t.Fatalf("Find() error: %v", err)
	}
	if found.ID != "bao-analysis" {
		t.Fatalf("Find() = %q, want exact top-level ID", found.ID)
	}
}

func TestParentPath(t *testing.T) {
	t.Parallel()
	tests := []struct {
		id   string
		want string
	}{
		{"", ""},
		{"a", ""},
		{"a/b", "a"},
		{"a/b/c", "a/b"},
		// Out of the fiber-ID domain, but "" is the only answer that reads as
		// "no parent" — "/" would be a fiber ID no store can hold.
		{"/a", ""},
	}
	for _, tt := range tests {
		if got := ParentPath(tt.id); got != tt.want {
			t.Errorf("ParentPath(%q) = %q, want %q", tt.id, got, tt.want)
		}
	}
}

func TestResolveAddPath(t *testing.T) {
	t.Parallel()
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
			name: "existing namespace directory wins over a nested basename match",
			slug: "roles/intendant",
			existing: []string{
				"roles/vizier",
				"games/civbench/harness-model/roles",
			},
			wantResolved:  "roles/intendant",
			wantRewritten: false,
		},
		{
			name:          "roles namespace stays top-level before it exists",
			slug:          "roles/intendant",
			existing:      []string{"games/civbench/harness-model/roles"},
			wantResolved:  "roles/intendant",
			wantRewritten: false,
		},
		{
			name:          "existing directory without its own fiber is an exact parent",
			slug:          "notes/new",
			existing:      []string{"notes/old", "project/notes"},
			wantResolved:  "notes/new",
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
	t.Parallel()
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
	t.Parallel()
	ids := []string{
		"project",
		"project/analysis",
		"project/question",
		"project/analysis/method",
	}

	got, err := ResolveScopedIDIn(ids, "project/analysis", "question", nil)
	if err != nil {
		t.Fatalf("ResolveScopedID() error: %v", err)
	}
	if got != "project/question" {
		t.Fatalf("ResolveScopedID() = %q, want %q", got, "project/question")
	}

	got, err = ResolveScopedIDIn(ids, "project/analysis", "method", nil)
	if err != nil {
		t.Fatalf("ResolveScopedID() nested error: %v", err)
	}
	if got != "project/analysis/method" {
		t.Fatalf("ResolveScopedID() = %q, want %q", got, "project/analysis/method")
	}
}

func TestResolveScopedIDPrefersExactBasenameOverPrefix(t *testing.T) {
	t.Parallel()
	// When a query matches one fiber exactly and others by prefix, the exact match wins.
	ids := []string{
		"project/status",
		"project/status-encoding-color-fog",
		"project/status-model-tasks-vs-knowledge",
	}

	got, err := ResolveScopedIDIn(ids, "project/analysis/strip-dead", "status", nil)
	if err != nil {
		t.Fatalf("ResolveScopedID() error: %v (should prefer exact match)", err)
	}
	if got != "project/status" {
		t.Fatalf("ResolveScopedID() = %q, want %q", got, "project/status")
	}
}

func TestResolveScopedIDPrefersExactPathOverDescendants(t *testing.T) {
	t.Parallel()
	// A slash-path to a parent fiber must resolve even though that parent has
	// children whose ids share its prefix (the children must not defeat it
	// into a spurious ambiguity error).
	ids := []string{
		"project/design/kanban",
		"project/design/kanban/drift-test",
		"project/design/kanban/property-test",
	}

	got, err := ResolveScopedIDIn(ids, "project/design/kanban/drift-test", "design/kanban", nil)
	if err != nil {
		t.Fatalf("ResolveScopedID() error: %v (parent with children should resolve)", err)
	}
	if got != "project/design/kanban" {
		t.Fatalf("ResolveScopedID() = %q, want %q", got, "project/design/kanban")
	}
}

func TestResolveScopedIDGlobalUniqueBasenameFallback(t *testing.T) {
	t.Parallel()
	// A globally-unique slug resolves from a scope that cannot reach it by
	// walking up — e.g. a cross-project link in the aggregated monorepo.
	ids := []string{
		"alpha/notes/setup",
		"beta/deploy/runbook",
	}

	got, err := ResolveScopedIDIn(ids, "alpha/notes/setup", "runbook", nil)
	if err != nil {
		t.Fatalf("ResolveScopedID() error: %v (unique slug should resolve globally)", err)
	}
	if got != "beta/deploy/runbook" {
		t.Fatalf("ResolveScopedID() = %q, want %q", got, "beta/deploy/runbook")
	}

	// A non-unique slug must NOT resolve via the fallback.
	ids = append(ids, "gamma/deploy/runbook")
	if got, err := ResolveScopedIDIn(ids, "alpha/notes/setup", "runbook", nil); err == nil {
		t.Fatalf("expected no resolution for non-unique slug, got %q", got)
	}
}

func TestFindProjectRoot(t *testing.T) {
	t.Parallel()
	// Create a nested directory structure with .felt at the top
	rootDir := t.TempDir()
	feltDir := filepath.Join(rootDir, ".felt")
	os.Mkdir(feltDir, 0755)

	nested := filepath.Join(rootDir, "a", "b", "c")
	os.MkdirAll(nested, 0755)

	// FindProjectRoot should find the root from the nested working directory
	found, err := FindProjectRoot(sysenv.New(nested, nil))
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
	t.Parallel()
	// Create a temp directory with no .felt
	dir := t.TempDir()

	_, err := FindProjectRoot(sysenv.New(dir, nil))
	if err == nil {
		t.Error("FindProjectRoot() should error when no .felt found")
	}
}

// TestStorageMoveSubtreeLeavesInputRefsThatStillResolve pins the rule for
// inputs.from: a top-level fiber nested under a parent keeps every spelling
// that still reaches it by path — its bare slug from inside its own subtree,
// a suffix path from outside — so none of them is rewritten, and a reference
// to an unmoved fiber is untouched.
func TestStorageMoveSubtreeLeavesInputRefsThatStillResolve(t *testing.T) {
	t.Parallel()
	_, s := newStore(t)

	parent := &Felt{
		ID:        "bao-analysis",
		Name:      "BAO Analysis",
		CreatedAt: time.Now(),
	}
	child := &Felt{ID: "damping-prior", Name: "Damping Prior", CreatedAt: time.Now()}
	mustExtra(t, child, "inputs", []map[string]any{{"id": "analysis_input", "from": "bao-analysis.posterior"}})
	grandchild := &Felt{ID: "damping-prior/contour-plot", Name: "Contour Plot", CreatedAt: time.Now()}
	mustExtra(t, grandchild, "inputs", []map[string]any{{"id": "plot_input", "from": "damping-prior.fit"}})
	consumer := &Felt{ID: "consumer", Name: "Consumer", CreatedAt: time.Now()}
	mustExtra(t, consumer, "inputs", []map[string]any{{"id": "consumer_input", "from": "damping-prior/contour-plot.figure"}})

	for _, f := range []*Felt{parent, child, grandchild, consumer} {
		if err := s.Write(f); err != nil {
			t.Fatalf("Write(%s) error: %v", f.ID, err)
		}
	}

	result, err := s.MoveSubtree("damping-prior", "bao-analysis/damping-prior")
	if err != nil {
		t.Fatalf("MoveSubtree() error: %v", err)
	}
	if len(result.Rewritten) != 0 {
		t.Fatalf("rewritten = %v, want none", result.Rewritten)
	}

	if _, err := s.Read("damping-prior"); err == nil {
		t.Fatal("old child ID should no longer exist")
	}
	for id, want := range map[string]string{
		"bao-analysis/damping-prior":              "bao-analysis.posterior",
		"bao-analysis/damping-prior/contour-plot": "damping-prior.fit",
		"consumer": "damping-prior/contour-plot.figure",
	} {
		f, err := s.Read(id)
		if err != nil {
			t.Fatalf("Read %s: %v", id, err)
		}
		if got := f.DataFlowInputs()[0].From; got != want {
			t.Fatalf("%s input = %q, want %q", id, got, want)
		}
	}
}

// TestStorageMoveSubtreeRewritesInputRefsItBreaks: inputs.from follows the
// body-link rule, so a reference spelled through the old parent is rewritten,
// its output fragment kept.
func TestStorageMoveSubtreeRewritesInputRefsItBreaks(t *testing.T) {
	t.Parallel()
	_, s := newStore(t)
	for _, id := range []string{"a", "b", "a/x", "a/x/y"} {
		if err := s.Write(&Felt{ID: id, Name: id, CreatedAt: time.Now()}); err != nil {
			t.Fatal(err)
		}
	}
	consumer := &Felt{ID: "consumer", Name: "Consumer", CreatedAt: time.Now()}
	mustExtra(t, consumer, "inputs", []map[string]any{{"id": "in", "from": "a/x/y.figure"}})
	if err := s.Write(consumer); err != nil {
		t.Fatal(err)
	}

	result, err := s.MoveSubtree("a/x", "b/x")
	if err != nil {
		t.Fatalf("MoveSubtree() error: %v", err)
	}
	if !reflect.DeepEqual(result.Rewritten, []string{"consumer"}) {
		t.Fatalf("rewritten = %v, want [consumer]", result.Rewritten)
	}
	f, err := s.Read("consumer")
	if err != nil {
		t.Fatal(err)
	}
	if got := f.DataFlowInputs()[0].From; got != "b/x/y.figure" {
		t.Fatalf("consumer input = %q, want b/x/y.figure", got)
	}
}

func TestStorageMoveSubtreePreservesLooseArtifacts(t *testing.T) {
	t.Parallel()
	_, s := newStore(t)

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

	if _, err := s.MoveSubtree("damping-prior", "bao-analysis/damping-prior"); err != nil {
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
	t.Parallel()
	_, s := newStore(t)

	f := &Felt{
		ID:        "bao-analysis",
		Name:      "BAO Analysis",
		CreatedAt: time.Now(),
	}
	if err := s.Write(f); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	if _, err := s.MoveSubtree("bao-analysis", "bao-analysis/damping-prior"); err == nil {
		t.Fatal("MoveSubtree should reject moving into its own subtree")
	}
}

func TestStorageMoveSubtreeRejectsExistingDestination(t *testing.T) {
	t.Parallel()
	_, s := newStore(t)

	for _, f := range []*Felt{
		{ID: "bao-analysis", Name: "BAO Analysis", CreatedAt: time.Now()},
		{ID: "bao-analysis/damping-prior", Name: "Existing Child", CreatedAt: time.Now()},
		{ID: "damping-prior", Name: "Top-level Child", CreatedAt: time.Now()},
	} {
		if err := s.Write(f); err != nil {
			t.Fatalf("Write(%s) error: %v", f.ID, err)
		}
	}

	if _, err := s.MoveSubtree("damping-prior", "bao-analysis/damping-prior"); err == nil {
		t.Fatal("MoveSubtree should reject an existing destination")
	}
}

func TestStorageMigrateFlatFiles(t *testing.T) {
	t.Parallel()
	_, s := newStore(t)

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
	t.Parallel()
	_, s := newStore(t)

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
	t.Parallel()
	_, s := newStore(t)

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
	t.Parallel()
	_, s := newStore(t)

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
	t.Parallel()
	_, s := newStore(t)

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
	t.Parallel()
	_, s := newStore(t)

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
	mustExtra(t, preExisting, "inputs", []map[string]any{{"id": "analysis_input", "from": "bao-analysis-d34db33f.posterior"}})
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
	t.Parallel()
	_, s := newStore(t)

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
	t.Parallel()
	_, s := newStore(t)

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
	t.Parallel()
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
	f, err := s.FindInScope("", "cmbx")
	if err != nil {
		t.Fatalf("Find: %v", err)
	}
	if f.Name != "cmbx" {
		t.Errorf("Find(cmbx).Name = %q, want cmbx", f.Name)
	}
}

func TestStoragePathFallsBackToDirectoryForm(t *testing.T) {
	t.Parallel()
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
	t.Parallel()
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
	t.Parallel()
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
	writeRawFiber(t, innerS.root, "section/subsection/leaf")

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

// TestStorageListSymlinkedFiberFile guards against a walker regression: a
// symlink whose target is a regular file (not a directory) — e.g. a single
// fiber .md symlinked in from elsewhere — must still be visited. The prior
// filepath.WalkDir-based walker handled this because it resolves symlinks
// transparently; the hand-rolled os.ReadDir walker introduced to reuse
// sibling DirEntry lists for report.html detection initially special-cased
// the symlink branch to only recurse-or-skip, silently dropping any symlink
// that didn't resolve to a directory.
func TestStorageListSymlinkedFiberFile(t *testing.T) {
	t.Parallel()
	tmp := t.TempDir()
	s := NewStorage(tmp)
	if err := s.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}

	// Real fiber file living outside the store's directory, in the
	// dir-basename-matches-file-stem shape fiberIDFromRelativePath expects
	// (id derivation walks the *resolved* symlink target, not the link's
	// own location, so the target itself must satisfy the convention).
	realDir := filepath.Join(tmp, "external", "linked")
	if err := os.MkdirAll(realDir, 0755); err != nil {
		t.Fatalf("mkdir external/linked: %v", err)
	}
	realMd := filepath.Join(realDir, "linked.md")
	if err := os.WriteFile(realMd, []byte("---\nname: linked\n---\n"), 0644); err != nil {
		t.Fatalf("write real md: %v", err)
	}
	realMdResolved, err := filepath.EvalSymlinks(realMd)
	if err != nil {
		t.Fatalf("EvalSymlinks(realMd): %v", err)
	}

	// A symlink at the store root pointing directly at that file (not a
	// directory) — the shape the walker regression dropped.
	linkPath := filepath.Join(s.root, "pointer.md")
	if err := os.Symlink(realMd, linkPath); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	felts, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	found := false
	for _, f := range felts {
		if f.Path == realMdResolved {
			found = true
			break
		}
	}
	if !found {
		var paths []string
		for _, f := range felts {
			paths = append(paths, f.Path)
		}
		t.Fatalf("symlinked fiber file missing from List(); got paths = %v", paths)
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
	t.Parallel()
	tmp := t.TempDir()

	// Outer monorepo store with a project's content nested inside it.
	outerS := NewStorage(filepath.Join(tmp, "monorepo"))
	if err := outerS.Init(); err != nil {
		t.Fatalf("outer init: %v", err)
	}
	projectDir := filepath.Join(outerS.root, "projects", "alpha")
	// Project root fiber. From inside the project (via the symlink set up
	// below), `.felt/alpha.md` is the bare entry-point shape. From the
	// outer view, the same file at `<.felt>/projects/alpha/alpha.md`
	// reads as the directory-form fiber `projects/alpha` — its parent
	// dir name matches the slug, so the existing fiberIDFromRelativePath
	// shape rule treats it as a directory-form fiber, not a bare-at-depth.
	writeRawFiber(t, outerS.root, "projects/alpha")
	// One nested fiber inside the project subtree.
	writeRawFiber(t, outerS.root, "projects/alpha/feature")

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

// newSubstoreFixture builds the substore shape the loom uses: an enclosing
// `.felt/` whose subdirectory `ai-futures/felt` holds another store's
// content, reached through a project whose `.felt` is a symlink to it.
// Returns the enclosing store's project dir and the substore's project dir.
func newSubstoreFixture(t *testing.T) (loomProj, subProj string) {
	t.Helper()
	tmp := t.TempDir()

	loomProj = filepath.Join(tmp, "loom")
	loom := NewStorage(loomProj)
	if err := loom.Init(); err != nil {
		t.Fatalf("loom init: %v", err)
	}
	// Fibers that live elsewhere in the enclosing store.
	for _, id := range []string{"commons", "ai-futures/portolan/debug"} {
		writeRawFiber(t, loom.root, id)
	}

	// The substore's content lives inside the enclosing store, under the
	// prefix; the project reaches it through a symlinked .felt.
	content := filepath.Join(loom.root, "ai-futures", "felt")
	if err := os.MkdirAll(content, 0755); err != nil {
		t.Fatalf("mkdir substore content: %v", err)
	}
	// Local fibers, which the enclosing store also sees — under the prefix.
	for _, id := range []string{"debug", "notes/runbook"} {
		writeRawFiber(t, content, id)
	}
	subProj = filepath.Join(tmp, "project")
	if err := os.MkdirAll(subProj, 0755); err != nil {
		t.Fatalf("mkdir project: %v", err)
	}
	if err := os.Symlink(content, filepath.Join(subProj, DirName)); err != nil {
		t.Fatalf("symlink substore: %v", err)
	}
	return loomProj, subProj
}

func TestEnclosingStoreReportsMountPoint(t *testing.T) {
	t.Parallel()
	loomProj, subProj := newSubstoreFixture(t)

	root, prefix, ok := NewStorage(subProj).EnclosingStore()
	if !ok {
		t.Fatalf("EnclosingStore() ok = false, want true for a mounted substore")
	}
	wantRoot, err := filepath.EvalSymlinks(filepath.Join(loomProj, DirName))
	if err != nil {
		t.Fatalf("EvalSymlinks: %v", err)
	}
	if root != wantRoot {
		t.Fatalf("EnclosingStore() root = %q, want %q", root, wantRoot)
	}
	if prefix != "ai-futures/felt" {
		t.Fatalf("EnclosingStore() prefix = %q, want %q", prefix, "ai-futures/felt")
	}

	// The enclosing store itself is enclosed by nothing.
	if _, _, ok := NewStorage(loomProj).EnclosingStore(); ok {
		t.Fatalf("EnclosingStore() ok = true for a top-level store")
	}
}

// TestResolveScopedIDRefusesEnclosingStorePath is the misresolution this whole
// mechanism exists to stop: from inside the substore, a link written out in
// full to a fiber in another project's tree used to be rescued by the
// basename fallback into the local fiber of the same slug.
func TestResolveScopedIDRefusesEnclosingStorePath(t *testing.T) {
	t.Parallel()
	_, subProj := newSubstoreFixture(t)
	external := NewStorage(subProj).ExternalRefs()
	if external == nil {
		t.Fatalf("ExternalRefs() = nil for a mounted substore")
	}
	ids := []string{"debug", "notes/runbook"}

	got, err := ResolveScopedIDIn(ids, "notes/runbook", "ai-futures/portolan/debug", external)
	if err == nil {
		t.Fatalf("resolved foreign path to %q; want an external-reference failure", got)
	}
	if !errors.Is(err, ErrExternalReference) {
		t.Fatalf("error = %v, want ErrExternalReference", err)
	}
	if !strings.Contains(err.Error(), external.Root()) {
		t.Fatalf("error %v should name the enclosing store %q", err, external.Root())
	}

	// A bare slug that names a top-level fiber out there resolves the same
	// way, off the cheap stat (see TestExternalPathLookupNeedsNoWalk).
	if _, err := ResolveScopedIDIn(ids, "notes/runbook", "commons", external); !errors.Is(err, ErrExternalReference) {
		t.Fatalf("[[commons]] error = %v, want ErrExternalReference", err)
	}
}

// TestExternalProbeStaysOffWhenItCannotMatter checks the cross-store resolver's
// cheap miss path. A lookup miss is common and must not walk the enclosing
// store; the probe can change the outcome only when basename fallback is about
// to fire.
func TestExternalProbeStaysOffWhenItCannotMatter(t *testing.T) {
	t.Parallel()
	_, subProj := newSubstoreFixture(t)
	external := NewStorage(subProj).ExternalRefs()
	ids := []string{"debug", "notes/runbook"}

	// No local fiber named `commons`, so nothing to rescue and nothing to
	// refuse: an ordinary miss, and the outer id list is never listed.
	if _, err := ResolveScopedIDIn(ids, "notes/runbook", "commons", external); err == nil {
		t.Fatalf("expected a resolution failure for a query with no local candidate")
	}
	if external.resolver != nil {
		t.Fatalf("enclosing store was walked for a query the probe cannot help")
	}

	// A fully-qualified foreign id is answered by the cheap stat — the shape
	// commands rely on, so it must not cost a walk either.
	if _, err := ResolveScopedIDIn(ids, "notes/runbook", "ai-futures/portolan/debug", external); !errors.Is(err, ErrExternalReference) {
		t.Fatalf("error = %v, want ErrExternalReference", err)
	}
	if external.resolver != nil {
		t.Fatalf("enclosing store was walked for an id its literal path already answered")
	}

	// A PARTIAL path resolves only by the enclosing store's own slug rules,
	// and a live basename fallback makes the verdict matter — so here the
	// walk is both necessary and paid for.
	if _, err := ResolveScopedIDIn(ids, "notes/runbook", "portolan/debug", external); !errors.Is(err, ErrExternalReference) {
		t.Fatalf("partial-path error = %v, want ErrExternalReference", err)
	}
	if external.resolver == nil {
		t.Fatalf("enclosing store should have been walked for a partial path")
	}
}

// TestExternalPathLookupNeedsNoWalk pins the cheap half on its own: a bare
// foreign slug that exists at the enclosing store's root is found by a stat,
// with no local same-slug fiber to make the gate open. Without this,
// `felt rm <foreign-slug>` would report "no fiber found" for a fiber that is
// plainly there.
func TestExternalPathLookupNeedsNoWalk(t *testing.T) {
	t.Parallel()
	_, subProj := newSubstoreFixture(t)
	external := NewStorage(subProj).ExternalRefs()
	ids := []string{"debug", "notes/runbook"}

	_, err := ResolveScopedIDIn(ids, "", "commons", external)
	if !errors.Is(err, ErrExternalReference) {
		t.Fatalf("error = %v, want ErrExternalReference", err)
	}
	if external.resolver != nil {
		t.Fatalf("enclosing store was walked for an id its literal path already answered")
	}
	ref, _ := AsExternalReference(err)
	if ref.ID != "commons" {
		t.Fatalf("ExternalReference.ID = %q, want %q", ref.ID, "commons")
	}
}

// TestResolveScopedIDLocalIDUnderOwnPrefixKeepsItsAddress: a local fiber whose
// id genuinely begins with this store's prefix must stay addressable by its
// real spelling — prefix stripping is a fallback, not a rewrite.
func TestResolveScopedIDLocalIDUnderOwnPrefixKeepsItsAddress(t *testing.T) {
	t.Parallel()
	_, subProj := newSubstoreFixture(t)
	external := NewStorage(subProj).ExternalRefs()
	ids := []string{"debug", "ai-futures/felt/debug"}

	got, err := ResolveScopedIDIn(ids, "", "ai-futures/felt/debug", external)
	if err != nil {
		t.Fatalf("ResolveScopedIDIn() error: %v", err)
	}
	if got != "ai-futures/felt/debug" {
		t.Fatalf("ResolveScopedIDIn() = %q, want the exact local id", got)
	}

	// And a miss under the prefix reports the query as the caller typed it.
	_, err = ResolveScopedIDIn(ids, "", "ai-futures/felt/nope", external)
	if err == nil || !strings.Contains(err.Error(), "ai-futures/felt/nope") {
		t.Fatalf("error = %v, want the original query in the message", err)
	}
}

func TestResolveScopedIDUnknownPathIsOrdinaryMiss(t *testing.T) {
	t.Parallel()
	_, subProj := newSubstoreFixture(t)
	external := NewStorage(subProj).ExternalRefs()
	ids := []string{"debug", "notes/runbook"}

	_, err := ResolveScopedIDIn(ids, "notes/runbook", "somewhere/else/gone", external)
	if err == nil {
		t.Fatalf("expected a resolution failure for a path that exists nowhere")
	}
	if errors.Is(err, ErrExternalReference) {
		t.Fatalf("error = %v, want an ordinary miss, not ErrExternalReference", err)
	}
	if !strings.Contains(err.Error(), "no fiber found") {
		t.Fatalf("error = %v, want a no-felt-found message", err)
	}
}

// TestResolveScopedIDStalePathRescueSurvives: the external check must not
// swallow the case it sits next to — a link whose path went stale after a
// `felt nest` but whose slug is still unique in this store.
func TestResolveScopedIDStalePathRescueSurvives(t *testing.T) {
	t.Parallel()
	_, subProj := newSubstoreFixture(t)
	external := NewStorage(subProj).ExternalRefs()
	ids := []string{"debug", "notes/runbook"}

	got, err := ResolveScopedIDIn(ids, "debug", "old/place/runbook", external)
	if err != nil {
		t.Fatalf("ResolveScopedIDIn() error: %v (stale path with a unique slug should still resolve)", err)
	}
	if got != "notes/runbook" {
		t.Fatalf("ResolveScopedIDIn() = %q, want %q", got, "notes/runbook")
	}
}

// TestResolveScopedIDLocalizesOwnPrefix: a link spelled from the enclosing
// store's namespace but pointing back into this store is local. The target
// exists in the enclosing store too (it is the same file), so the prefix
// strip has to happen before the external check.
func TestResolveScopedIDLocalizesOwnPrefix(t *testing.T) {
	t.Parallel()
	_, subProj := newSubstoreFixture(t)
	storage := NewStorage(subProj)
	external := storage.ExternalRefs()
	ids := []string{"debug", "notes/runbook"}

	got, err := ResolveScopedIDIn(ids, "notes/runbook", "ai-futures/felt/debug", external)
	if err != nil {
		t.Fatalf("ResolveScopedIDIn() error: %v (own-prefix link should resolve locally)", err)
	}
	if got != "debug" {
		t.Fatalf("ResolveScopedIDIn() = %q, want %q", got, "debug")
	}
}

// TestResolveScopedIDEnclosingHitInsideOwnPrefixIsLocal: the enclosing store
// can reach this store's own fibers, so a hit under our prefix must not be
// called external — it falls through to the local fallbacks.
func TestResolveScopedIDEnclosingHitInsideOwnPrefixIsLocal(t *testing.T) {
	t.Parallel()
	_, subProj := newSubstoreFixture(t)
	external := NewStorage(subProj).ExternalRefs()
	ids := []string{"debug", "notes/runbook"}

	got, err := ResolveScopedIDIn(ids, "debug", "stale/path/notes/runbook", external)
	if err != nil {
		t.Fatalf("ResolveScopedIDIn() error: %v (a local fiber must not read as external)", err)
	}
	if got != "notes/runbook" {
		t.Fatalf("ResolveScopedIDIn() = %q, want %q", got, "notes/runbook")
	}
}

// TestStorageLookupsKnowTheEnclosingStore covers the user-typed path: from
// inside the substore, `felt show <foreign/path>` must say "lives elsewhere"
// rather than quietly showing the local fiber of the same slug, while a link
// spelled with this store's own prefix still opens the local fiber.
func TestStorageLookupsKnowTheEnclosingStore(t *testing.T) {
	t.Parallel()
	_, subProj := newSubstoreFixture(t)
	storage := NewStorage(subProj)
	external := storage.ExternalRefs()

	_, err := storage.FindInScope("", "ai-futures/portolan/debug")
	if !errors.Is(err, ErrExternalReference) {
		t.Fatalf("FindInScope() error = %v, want ErrExternalReference", err)
	}
	// The failure carries what a command needs to act on the fiber where it
	// lives — the id out there and the store that holds it — and suggests no
	// command of its own: this package does not know which verb was typed.
	ref, ok := AsExternalReference(err)
	if !ok {
		t.Fatalf("error %v does not carry ExternalReference detail", err)
	}
	if ref.ID != "ai-futures/portolan/debug" {
		t.Fatalf("ExternalReference.ID = %q, want the id in the enclosing store", ref.ID)
	}
	if ref.Root != external.Root() || ref.ProjectDir != external.ProjectDir() {
		t.Fatalf("ExternalReference location = %q/%q, want %q/%q", ref.Root, ref.ProjectDir, external.Root(), external.ProjectDir())
	}
	if strings.Contains(err.Error(), "felt -C") || strings.Contains(err.Error(), "try ") {
		t.Fatalf("error %v should not suggest a command", err)
	}

	f, err := storage.FindInScope("", "ai-futures/felt/notes/runbook")
	if err != nil {
		t.Fatalf("FindInScope() own-prefix error: %v", err)
	}
	if f.ID != "notes/runbook" {
		t.Fatalf("FindInScope() = %q, want %q", f.ID, "notes/runbook")
	}
}

// newStore builds an initialized store rooted at a fresh temp dir.
func newStore(t *testing.T) (string, *Storage) {
	t.Helper()
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	return dir, s
}

// writeRawFiber plants a minimal directory-form fiber under root, bypassing
// storage so the walk logic sees only what is on disk.
func writeRawFiber(t *testing.T, root, id string) {
	t.Helper()
	dir := filepath.Join(root, filepath.FromSlash(id))
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("mkdir %s: %v", id, err)
	}
	file := filepath.Join(dir, filepath.Base(id)+FileExt)
	if err := os.WriteFile(file, []byte("---\nname: "+filepath.Base(id)+"\n---\n"), 0644); err != nil {
		t.Fatalf("write %s: %v", id, err)
	}
}

// TestStrayFiberFileIsNotAFiber: the directory model is the only one. A bare
// `<dir>/<slug>.md` below the root — stray fiber or companion alike — is not
// listed, not addressable by the id its path suggests, and not claimed by
// CheckAvailableID; a lookup that misses because of a stray says why.
func TestStrayFiberFileIsNotAFiber(t *testing.T) {
	t.Parallel()
	_, s := newStore(t)
	writeRawFiber(t, s.root, "parent")
	writeFile(t, s.root, "parent/leaf.md", "---\nname: leaf\ntags: [x]\n---\n")
	writeFile(t, s.root, "parent/survey.md", "# survey\n\nplain companion\n")

	felts, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(felts) != 1 || felts[0].ID != "parent" {
		t.Fatalf("List = %v, want only parent", feltIDs(felts))
	}
	if got, want := s.Path("parent/leaf"), filepath.Join(s.root, "parent", "leaf", "leaf.md"); got != want {
		t.Errorf("Path(parent/leaf) = %q, want the directory form %q", got, want)
	}
	if err := s.CheckAvailableID("parent/survey"); err != nil {
		t.Errorf("a companion file must not claim its id: %v", err)
	}
	_, err = s.FindInScope("", "parent/leaf")
	if err == nil || !strings.Contains(err.Error(), ".felt/parent/leaf.md") || !strings.Contains(err.Error(), LegacyFlatMigrationHint) {
		t.Errorf("FindInScope(parent/leaf) error = %v, want a pointer at the stray file and migrate", err)
	}
	if _, err := s.FindInScope("", "parent/survey"); err == nil || strings.Contains(err.Error(), "migrate") {
		t.Errorf("FindInScope(parent/survey) error = %v, want a plain miss", err)
	}
}

// TestStorageMountedEntryPointIsNotStray: the bare form below the root is
// legitimate in exactly one place — the entry-point fiber of a store mounted
// through a symlinked subdirectory. It stays listed and addressable, and is
// not reported as stray; a bare file one level inside that mount is.
func TestStorageMountedEntryPointIsNotStray(t *testing.T) {
	t.Parallel()
	tmp := t.TempDir()
	outer := NewStorage(filepath.Join(tmp, "outer"))
	if err := outer.Init(); err != nil {
		t.Fatalf("outer init: %v", err)
	}
	inner := NewStorage(filepath.Join(tmp, "inner"))
	if err := inner.Init(); err != nil {
		t.Fatalf("inner init: %v", err)
	}
	writeFile(t, inner.root, "guest.md", "---\nname: guest\ntags: [x]\n---\n")
	writeRawFiber(t, inner.root, "section")
	writeFile(t, inner.root, "section/loose.md", "---\nname: loose\ntags: [x]\n---\n")
	if err := os.MkdirAll(filepath.Join(outer.root, "mounts"), 0755); err != nil {
		t.Fatalf("mkdir mounts: %v", err)
	}
	if err := os.Symlink(inner.root, filepath.Join(outer.root, "mounts", "guest")); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	f, err := outer.FindInScope("", "mounts/guest/guest")
	if err != nil || f.Name != "guest" {
		t.Fatalf("FindInScope(mounts/guest/guest) = %v, %v; want the mounted entry point", f, err)
	}
	strays, err := outer.StrayFibers()
	if err != nil {
		t.Fatalf("StrayFibers: %v", err)
	}
	if len(strays) != 1 || strays[0].Rel != "mounts/guest/section/loose.md" || strays[0].TargetRel != "mounts/guest/section/loose/loose.md" {
		t.Fatalf("strays = %+v, want only the loose file inside the mount", strays)
	}
}

// TestStorageMigrateFoldsStrayFiber: migrate folds a stray fiber file into
// `<slug>/<slug>.md` (dry run only reports it), after which it is an ordinary
// fiber and a link spelling its path resolves. Companion markdown is untouched.
func TestStorageMigrateFoldsStrayFiber(t *testing.T) {
	t.Parallel()
	_, s := newStore(t)
	writeRawFiber(t, s.root, "parent")
	stray := writeFile(t, s.root, "parent/leaf.md", "---\nname: leaf\ntags: [x]\n---\nleaf body\n")
	companion := writeFile(t, s.root, "parent/survey.md", "# survey\n")

	dry, err := s.Migrate(true)
	if err != nil {
		t.Fatalf("Migrate(dry): %v", err)
	}
	if len(dry.Strays) != 1 || dry.Strays[0].Rel != "parent/leaf.md" || dry.Strays[0].TargetRel != "parent/leaf/leaf.md" || dry.Strays[0].Blocked != "" {
		t.Fatalf("dry-run strays = %+v, want parent/leaf.md -> parent/leaf/leaf.md", dry.Strays)
	}
	if _, err := os.Stat(stray); err != nil {
		t.Fatalf("dry run moved the stray: %v", err)
	}

	if _, err := s.Migrate(false); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	if _, err := os.Stat(stray); !os.IsNotExist(err) {
		t.Errorf("stray still at its old path: %v", err)
	}
	f, err := s.FindInScope("", "parent/leaf")
	if err != nil || strings.TrimSpace(f.Body) != "leaf body" {
		t.Fatalf("FindInScope(parent/leaf) = %+v, %v; want the folded fiber", f, err)
	}
	if _, err := os.Stat(companion); err != nil {
		t.Errorf("companion was moved: %v", err)
	}
	again, err := s.Migrate(true)
	if err != nil || len(again.Strays) != 0 {
		t.Fatalf("second dry run = %+v, %v; want nothing left", again, err)
	}
}

// TestStorageMigrateRefusesStrayCollision: a stray whose directory-form home
// already holds a fiber is reported Blocked and left where it is; the fiber
// already there is untouched and the rest of the pass still runs.
func TestStorageMigrateRefusesStrayCollision(t *testing.T) {
	t.Parallel()
	_, s := newStore(t)
	writeRawFiber(t, s.root, "parent/leaf")
	stray := writeFile(t, s.root, "parent/leaf.md", "---\nname: other leaf\ntags: [x]\n---\n")
	writeFile(t, s.root, "parent/twig.md", "---\nname: twig\ntags: [x]\n---\n")
	home := filepath.Join(s.root, "parent", "leaf", "leaf.md")
	before, _ := os.ReadFile(home)

	result, err := s.Migrate(false)
	if err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	blocked := map[string]bool{}
	for _, sf := range result.Strays {
		blocked[sf.Rel] = sf.Blocked != ""
	}
	if !blocked["parent/leaf.md"] || blocked["parent/twig.md"] || len(blocked) != 2 {
		t.Fatalf("strays = %+v, want leaf blocked and twig folded", result.Strays)
	}
	if _, err := os.Stat(stray); err != nil {
		t.Errorf("blocked stray was moved: %v", err)
	}
	if after, _ := os.ReadFile(home); string(after) != string(before) {
		t.Errorf("existing fiber overwritten:\n%s", after)
	}
	if _, err := os.Stat(filepath.Join(s.root, "parent", "twig", "twig.md")); err != nil {
		t.Errorf("unblocked stray not folded: %v", err)
	}
}

func feltIDs(felts []*Felt) []string {
	ids := make([]string, 0, len(felts))
	for _, f := range felts {
		ids = append(ids, f.ID)
	}
	return ids
}

const strayFrontmatter = "---\nname: %s\nstatus: open\n---\n"

func writeStray(t *testing.T, root, rel string) string {
	t.Helper()
	return writeFile(t, root, rel, fmt.Sprintf(strayFrontmatter, strings.TrimSuffix(filepath.Base(rel), ".md")))
}

// TestLookupOfStrayIDRefusesSlugTwin: a query naming a stray's exact id —
// directly, or through the citing scope — must not fall through to the slug
// rescue and answer with a same-named fiber elsewhere, which `rm` would then
// delete.
func TestLookupOfStrayIDRefusesSlugTwin(t *testing.T) {
	t.Parallel()
	_, s := newStore(t)
	writeRawFiber(t, s.root, "proj/a/citer")
	writeRawFiber(t, s.root, "x/leaf2")
	writeStray(t, s.root, "proj/a/leaf2.md")

	for _, tc := range []struct{ scope, query string }{
		{"", "proj/a/leaf2"},
		{"proj/a/citer", "leaf2"},
		{"proj/a", "leaf2"},
	} {
		f, err := s.FindMetadataInScope(tc.scope, tc.query)
		if err == nil {
			t.Errorf("Find(%q in %q) = %s, want a refusal naming the stray", tc.query, tc.scope, f.ID)
			continue
		}
		if !strings.Contains(err.Error(), ".felt/proj/a/leaf2.md") || !strings.Contains(err.Error(), LegacyFlatMigrationHint) {
			t.Errorf("Find(%q in %q) error = %v", tc.query, tc.scope, err)
		}
	}
	// A bare slug from elsewhere names no stray path, and still finds the
	// one fiber of that name.
	if f, err := s.FindMetadataInScope("", "leaf2"); err != nil || f.ID != "x/leaf2" {
		t.Errorf("Find(leaf2) = %v, %v; want x/leaf2", f, err)
	}
}

// TestCheckAvailableIDRefusesStray: creating a fiber at a stray's id would
// manufacture the collision migrate cannot resolve.
func TestCheckAvailableIDRefusesStray(t *testing.T) {
	t.Parallel()
	_, s := newStore(t)
	writeRawFiber(t, s.root, "proj/a")
	writeStray(t, s.root, "proj/a/leaf3.md")

	err := s.CheckAvailableID("proj/a/leaf3")
	if err == nil || !strings.Contains(err.Error(), ".felt/proj/a/leaf3.md") || !strings.Contains(err.Error(), LegacyFlatMigrationHint) {
		t.Fatalf("CheckAvailableID = %v, want a stray refusal", err)
	}
}

// TestStorageMigrateBlocksFoldThroughSymlink: a stray whose directory-form
// home is a symlinked mount would be written into the mounted store's root.
// It is reported blocked and nothing moves.
func TestStorageMigrateBlocksFoldThroughSymlink(t *testing.T) {
	t.Parallel()
	tmp := t.TempDir()
	outer := NewStorage(filepath.Join(tmp, "outer"))
	inner := NewStorage(filepath.Join(tmp, "inner"))
	for _, st := range []*Storage{outer, inner} {
		if err := st.Init(); err != nil {
			t.Fatalf("init: %v", err)
		}
	}
	writeRawFiber(t, inner.root, "section")
	if err := os.MkdirAll(filepath.Join(outer.root, "mounts"), 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.Symlink(inner.root, filepath.Join(outer.root, "mounts", "guest")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	stray := writeStray(t, outer.root, "mounts/guest.md")

	result, err := outer.Migrate(false)
	if err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	if len(result.Strays) != 1 || !strings.Contains(result.Strays[0].Blocked, "symlink") {
		t.Fatalf("strays = %+v, want mounts/guest.md blocked by the symlink", result.Strays)
	}
	if _, err := os.Stat(stray); err != nil {
		t.Errorf("blocked stray moved: %v", err)
	}
	if _, err := os.Stat(filepath.Join(inner.root, "guest.md")); !os.IsNotExist(err) {
		t.Errorf("fold wrote into the mounted store: %v", err)
	}
}

// TestStraySymlinkIsReportedNotFolded: a symlinked loose file is reported
// under its own path and never moved, and the stray it points to is held back
// too, since folding it would leave the link dangling.
func TestStraySymlinkIsReportedNotFolded(t *testing.T) {
	t.Parallel()
	_, s := newStore(t)
	writeRawFiber(t, s.root, "parent")
	writeRawFiber(t, s.root, "notes")
	draft := writeStray(t, s.root, "notes/draft.md")
	alias := filepath.Join(s.root, "parent", "alias.md")
	if err := os.Symlink(filepath.Join("..", "notes", "draft.md"), alias); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	result, err := s.Migrate(false)
	if err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	blocked := map[string]string{}
	for _, sf := range result.Strays {
		blocked[sf.Rel] = sf.Blocked
	}
	if len(blocked) != 2 || !strings.Contains(blocked["parent/alias.md"], "is a symlink") || !strings.Contains(blocked["notes/draft.md"], ".felt/parent/alias.md") {
		t.Fatalf("strays = %+v, want the alias and its target both blocked", result.Strays)
	}
	if _, err := os.Stat(alias); err != nil {
		t.Errorf("alias dangles or moved: %v", err)
	}
	if _, err := os.Stat(draft); err != nil {
		t.Errorf("linked stray moved: %v", err)
	}
}

// TestStorageMigrateStrayBlockersAndFailures: every obstacle is found before
// anything moves — a plain file where the directory would go — and a fold
// that fails anyway is reported as blocked while the pass carries on: the
// other stray folds and the normalization still runs.
func TestStorageMigrateStrayBlockersAndFailures(t *testing.T) {
	t.Parallel()
	if os.Geteuid() == 0 {
		t.Skip("permission bits do not bind root")
	}
	_, s := newStore(t)
	writeRawFiber(t, s.root, "parent")
	writeFile(t, s.root, "parent/blk", "not a directory\n")
	writeStray(t, s.root, "parent/blk.md")
	writeStray(t, s.root, "parent/ok.md")
	writeRawFiber(t, s.root, "locked")
	writeStray(t, s.root, "locked/stuck.md")
	writeFile(t, s.root, "legacy/legacy.md", "---\ntitle: Legacy\n---\n")
	lockedDir := filepath.Join(s.root, "locked")
	if err := os.Chmod(lockedDir, 0555); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { os.Chmod(lockedDir, 0755) })

	result, err := s.Migrate(false)
	if err != nil {
		t.Fatalf("Migrate aborted: %v", err)
	}
	blocked := map[string]string{}
	for _, sf := range result.Strays {
		blocked[sf.Rel] = sf.Blocked
	}
	if !strings.Contains(blocked["parent/blk.md"], "a file already sits") {
		t.Errorf("parent/blk.md blocker = %q", blocked["parent/blk.md"])
	}
	if blocked["locked/stuck.md"] == "" {
		t.Errorf("failed fold not reported: %+v", result.Strays)
	}
	if blocked["parent/ok.md"] != "" {
		t.Errorf("parent/ok.md blocked: %q", blocked["parent/ok.md"])
	}
	if _, err := os.Stat(filepath.Join(s.root, "parent", "ok", "ok.md")); err != nil {
		t.Errorf("unblocked stray not folded: %v", err)
	}
	if len(result.TitleToNameIDs) != 1 || result.TitleToNameIDs[0] != "legacy" {
		t.Errorf("normalization skipped: %+v", result.TitleToNameIDs)
	}
}

// TestStrayHiddenPathIsStoreLevel: a hidden segment anywhere in the store
// path — here, a store mounted under `.archive/` — keeps loose files out.
func TestStrayHiddenPathIsStoreLevel(t *testing.T) {
	t.Parallel()
	tmp := t.TempDir()
	outer := NewStorage(filepath.Join(tmp, "outer"))
	other := NewStorage(filepath.Join(tmp, "other"))
	for _, st := range []*Storage{outer, other} {
		if err := st.Init(); err != nil {
			t.Fatalf("init: %v", err)
		}
	}
	writeRawFiber(t, other.root, "sec")
	writeStray(t, other.root, "sec/loose.md")
	if err := os.MkdirAll(filepath.Join(outer.root, ".archive"), 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.Symlink(other.root, filepath.Join(outer.root, ".archive", "mnt")); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	strays, err := outer.StrayFibers()
	if err != nil {
		t.Fatalf("StrayFibers: %v", err)
	}
	if len(strays) != 0 {
		t.Fatalf("strays = %+v, want none under a hidden path", strays)
	}
	if strays, _ := other.StrayFibers(); len(strays) != 1 {
		t.Fatalf("the mounted store's own view should still see its stray: %+v", strays)
	}
}

// TestStrayTitleDocumentIsACompanion: a `title:` document is a companion
// even when it carries a fiber-shaped key — validation reports record their
// own `status:` and `date:`.
func TestStrayTitleDocumentIsACompanion(t *testing.T) {
	t.Parallel()
	_, s := newStore(t)
	writeRawFiber(t, s.root, "parent")
	writeFile(t, s.root, "parent/report.md", "---\ntitle: Validation\ndate: 2026-07-16\nstatus: closed\nverdict: equivalent\n---\n")

	strays, err := s.StrayFibers()
	if err != nil {
		t.Fatalf("StrayFibers: %v", err)
	}
	if len(strays) != 0 {
		t.Fatalf("strays = %+v, want none", strays)
	}
}

// TestReadFrontmatterFileMatchesSplit: the bounded reader returns exactly
// what SplitFrontmatter finds in the whole file, errors included.
func TestReadFrontmatterFileMatchesSplit(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	for i, content := range []string{
		"---\nname: a\n---\nbody\n",
		"---\r\nname: a\r\n---\r\nbody\r\n",
		"---\nname: a\n---",
		"---\nname: a\n----\nstill: frontmatter\n---\n",
		"---\nname: a\n",
		"---",
		"# no frontmatter\n---\n",
		"",
	} {
		p := filepath.Join(dir, fmt.Sprintf("f%d.md", i))
		if err := os.WriteFile(p, []byte(content), 0644); err != nil {
			t.Fatalf("write: %v", err)
		}
		got, gotErr := readFrontmatterFile(p)
		want, _, wantErr := SplitFrontmatter([]byte(content), false)
		if string(got) != string(want) || (gotErr == nil) != (wantErr == nil) || (gotErr != nil && gotErr.Error() != wantErr.Error()) {
			t.Errorf("%q: got (%q, %v), want (%q, %v)", content, got, gotErr, want, wantErr)
		}
	}
}

// TestMemoizeWalkForgetsOnWrite: a memoized walk serves repeat listings, and
// a write through the same Storage drops it.
func TestMemoizeWalkForgetsOnWrite(t *testing.T) {
	t.Parallel()
	_, s := newStore(t)
	s.MemoizeWalk()
	writeRawFiber(t, s.root, "one")
	if felts, _ := s.ListMetadata(); len(felts) != 1 {
		t.Fatalf("first listing = %v", feltIDs(felts))
	}
	writeRawFiber(t, s.root, "behind-its-back")
	if felts, _ := s.ListMetadata(); len(felts) != 1 {
		t.Fatalf("memoized listing should not re-walk: %v", feltIDs(felts))
	}
	if err := s.Write(&Felt{ID: "two", Name: "Two"}); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if felts, _ := s.ListMetadata(); len(felts) != 3 {
		t.Fatalf("listing after a write = %v, want all three", feltIDs(felts))
	}
}

// TestSymlinkedFiberFileIsNamedByItsOwnPath: a fiber file symlinked in from
// outside the store is named by where the link sits, as a symlinked directory
// is. `a/a.md` is directory form by its own path, so it is the fiber `a`, not
// a stray; its target's path never leaks into the id.
func TestSymlinkedFiberFileIsNamedByItsOwnPath(t *testing.T) {
	t.Parallel()
	tmp := t.TempDir()
	s := NewStorage(filepath.Join(tmp, "p"))
	if err := s.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	writeStray(t, filepath.Join(tmp, "ext"), "notes/thing.md")
	writeRawFiber(t, filepath.Join(tmp, "ext"), "y")
	for link, target := range map[string]string{"a/a.md": "notes/thing.md", "yy/yy.md": "y/y.md"} {
		p := filepath.Join(s.root, filepath.FromSlash(link))
		if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.Symlink(filepath.Join(tmp, "ext", filepath.FromSlash(target)), p); err != nil {
			t.Fatalf("symlink: %v", err)
		}
	}

	felts, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if got := strings.Join(feltIDs(felts), ","); got != "a,yy" {
		t.Fatalf("ids = %s, want a,yy", got)
	}
	if strays, _ := s.StrayFibers(); len(strays) != 0 {
		t.Fatalf("strays = %+v, want none", strays)
	}
}

// TestStrayDifferingOnlyInCaseIsBlocked: `Notes/notes.md` is its directory's
// own file spelled in another case — on a case-insensitive filesystem it even
// opens as `Notes`. Folding it to `Notes/notes/notes.md` would change its id,
// so it is reported with a rename instead.
func TestStrayDifferingOnlyInCaseIsBlocked(t *testing.T) {
	t.Parallel()
	_, s := newStore(t)
	stray := writeStray(t, s.root, "Notes/notes.md")

	result, err := s.Migrate(false)
	if err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	if len(result.Strays) != 1 || !strings.Contains(result.Strays[0].Blocked, "rename it to Notes/Notes.md") {
		t.Fatalf("strays = %+v, want Notes/notes.md blocked with a rename", result.Strays)
	}
	if _, err := os.Stat(stray); err != nil {
		t.Fatalf("stray moved: %v", err)
	}
}

// TestCheckFromViewLocalizedLinkToStrayIsBroken: from a project view, a link
// spelled with the view's own prefix (`[[ai-futures/felt/a/bar]]`) localizes
// to the stray `a/bar` and is broken — not rescued to the twin `b/bar` — and a
// link naming a stray in the enclosing store reports that store's file.
func TestCheckFromViewLocalizedLinkToStrayIsBroken(t *testing.T) {
	t.Parallel()
	loomProj, subProj := newSubstoreFixture(t)
	loom := NewStorage(loomProj)
	sub := NewStorage(subProj)
	writeRawFiber(t, sub.root, "a")
	writeRawFiber(t, sub.root, "b/bar")
	writeStray(t, sub.root, "a/bar.md")
	writeRawFiber(t, loom.root, "commons/x")
	writeRawFiber(t, loom.root, "commons/y/foo")
	writeStray(t, loom.root, "commons/x/foo.md")

	felts, err := sub.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	felts = append(felts, &Felt{ID: "citer", Name: "Citer", Body: "[[ai-futures/felt/a/bar]] [[commons/x/foo]]"})
	strays, err := sub.StrayFibers()
	if err != nil {
		t.Fatalf("StrayFibers: %v", err)
	}
	var messages []string
	for _, issue := range Check(felts, sub.ExternalRefs(), strays...) {
		if issue.FiberID == "citer" {
			messages = append(messages, issue.Message)
		}
	}
	if len(messages) != 2 ||
		!strings.Contains(messages[0], `"ai-futures/felt/a/bar": .felt/a/bar.md is a stray fiber file`) ||
		!strings.Contains(messages[1], filepath.Join("commons", "x", "foo.md")+" is a stray fiber file") {
		t.Fatalf("citer issues = %q", messages)
	}
}

// TestResolveScopedIDExactOuterScopeBeatsInnerPrefix: every exact answer
// outranks every completion. From scope a/b, [[c]] names a/c exactly; a/b/cx
// only begins with the same letter.
func TestResolveScopedIDExactOuterScopeBeatsInnerPrefix(t *testing.T) {
	t.Parallel()
	ids := []string{"a", "a/b", "a/b/cx", "a/c"}
	for _, tc := range []struct{ scope, query, want string }{
		{"a/b", "c", "a/c"},
		{"a/b", "b/c", "a/b/cx"}, // no exact a/b/c anywhere: completion still works
		{"a/b", "cx", "a/b/cx"},
	} {
		got, err := ResolveScopedIDIn(ids, tc.scope, tc.query, nil)
		if err != nil || got != tc.want {
			t.Errorf("resolve(%q from %q) = %q, %v; want %q", tc.query, tc.scope, got, err, tc.want)
		}
	}
}

// TestDataFlowEdgeNeedsFromNotID: an inputs entry is an edge when it names a
// source in from:, labelled or not — the same set a move rewrites — so
// --consumers and check see an unlabelled entry too, and an id without a
// from is no edge.
func TestDataFlowEdgeNeedsFromNotID(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatal(err)
	}
	for _, f := range []*Felt{{ID: "source", Name: "Source"}, {ID: "reader", Name: "Reader"}} {
		if f.ID == "reader" {
			if err := f.SetExtraField("inputs", []map[string]any{
				{"id": "labelled", "from": "source"},
				{"from": "source"},
				{"id": "dangling"},
			}); err != nil {
				t.Fatal(err)
			}
		}
		if err := s.Write(f); err != nil {
			t.Fatal(err)
		}
	}
	reader, err := s.Read("reader")
	if err != nil {
		t.Fatal(err)
	}
	inputs := reader.DataFlowInputs()
	if len(inputs) != 2 || inputs[0].Path() != "inputs.labelled.from" || inputs[1].Path() != "inputs[1].from" {
		t.Fatalf("DataFlowInputs() = %+v, want the two entries with a from", inputs)
	}
	_, consumers, err := s.ScanRelationships("source")
	if err != nil {
		t.Fatal(err)
	}
	if len(consumers) != 2 {
		t.Fatalf("consumers of source = %+v, want both entries", consumers)
	}
}

// TestFiberFileSpelledAsIDIsNotStray: `science/cmbx/cmbx` spells the path of
// the fiber science/cmbx's own file. That file is in the layout, so the query
// is an ordinary stale path — show rescues it by its slug — and never a
// stray to migrate.
func TestFiberFileSpelledAsIDIsNotStray(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s := NewStorage(dir)
	if err := s.Init(); err != nil {
		t.Fatal(err)
	}
	if err := s.Write(&Felt{ID: "science/cmbx", Name: "cmbx", Status: StatusOpen}); err != nil {
		t.Fatal(err)
	}
	if rel, ok := s.strayAt("science/cmbx/cmbx"); ok {
		t.Fatalf("strayAt(science/cmbx/cmbx) = %q, want no stray", rel)
	}
	f, err := s.FindInScope("", "science/cmbx/cmbx")
	if err != nil || f.ID != "science/cmbx" {
		t.Fatalf("FindInScope = %v, %v; want science/cmbx", f, err)
	}
}

// TestAmbiguousSlugNamesItsCandidates: a slug that tails several fibers
// resolves to none and says which, while still reading as no match.
func TestAmbiguousSlugNamesItsCandidates(t *testing.T) {
	t.Parallel()
	_, s := newStore(t)
	writeRawFiber(t, s.root, "science/cmbx/data")
	writeRawFiber(t, s.root, "science/lensing/data")
	writeRawFiber(t, s.root, "science/cmbx/likelihood")

	_, err := s.FindMetadataWithoutGuessing("", "data")
	var ambiguous *AmbiguousFiberError
	if !errors.As(err, &ambiguous) || !reflect.DeepEqual(ambiguous.Candidates, []string{"science/cmbx/data", "science/lensing/data"}) {
		t.Errorf("Find(data) error = %v, want an ambiguity naming both data fibers", err)
	}
	var missing *NoFiberMatchError
	if !errors.As(err, &missing) {
		t.Errorf("Find(data) ambiguity does not read as no match: %v", err)
	}
	if f, err := s.FindMetadataWithoutGuessing("", "cmbx/data"); err != nil || f.ID != "science/cmbx/data" {
		t.Errorf("Find(cmbx/data) = %v, %v; want science/cmbx/data", f, err)
	}
	if f, err := s.FindMetadataWithoutGuessing("", "likelihood"); err != nil || f.ID != "science/cmbx/likelihood" {
		t.Errorf("Find(likelihood) = %v, %v; want science/cmbx/likelihood", f, err)
	}
}
