package felt

import (
	"testing"
	"time"
)

func TestIndexSyncBuildsCitationsAndFTS(t *testing.T) {
	dir := t.TempDir()
	storage := NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	baseTime := time.Date(2026, 4, 10, 9, 0, 0, 0, time.UTC)
	for _, fiber := range []*Felt{
		{
			ID:        "project/question",
			Name:      "Question",
			CreatedAt: baseTime,
		},
		{
			ID:        "project/analysis",
			Name:      "Analysis",
			CreatedAt: baseTime,
			Body:      "See [[question]] and #question.",
			Inputs: []ASTRAInput{
				{ID: "catalog", From: "question.output"},
			},
		},
	} {
		if err := storage.Write(fiber); err != nil {
			t.Fatalf("Write(%s) error: %v", fiber.ID, err)
		}
	}

	idx, err := storage.OpenIndex()
	if err != nil {
		t.Fatalf("OpenIndex() error: %v", err)
	}
	defer idx.Close()

	citations, err := idx.Citations("project/question")
	if err != nil {
		t.Fatalf("Citations() error: %v", err)
	}
	if len(citations) != 1 {
		t.Fatalf("len(Citations()) = %d, want 1", len(citations))
	}
	if citations[0].SourceID != "project/analysis" {
		t.Fatalf("citation source = %q, want %q", citations[0].SourceID, "project/analysis")
	}

	consumers, err := idx.Consumers("project/question")
	if err != nil {
		t.Fatalf("Consumers() error: %v", err)
	}
	if len(consumers) != 1 {
		t.Fatalf("len(Consumers()) = %d, want 1", len(consumers))
	}
	if consumers[0].SourceID != "project/analysis" || consumers[0].OutputID != "output" || consumers[0].InputID != "catalog" {
		t.Fatalf("Consumers(project/question) = %#v, want project/analysis catalog <- output", consumers)
	}

	ids, err := idx.SearchBodyIDs("See [[question]]")
	if err != nil {
		t.Fatalf("SearchBodyIDs() error: %v", err)
	}
	if len(ids) != 1 || ids[0] != "project/analysis" {
		t.Fatalf("SearchBodyIDs() = %v, want [project/analysis]", ids)
	}
}

func TestIndexSyncUpdatesChangedFibers(t *testing.T) {
	dir := t.TempDir()
	storage := NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	fiber := &Felt{
		ID:        "fiber-a",
		Name:      "Fiber A",
		CreatedAt: time.Date(2026, 4, 10, 9, 0, 0, 0, time.UTC),
		Body:      "old body",
	}
	if err := storage.Write(fiber); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	idx, err := storage.OpenIndex()
	if err != nil {
		t.Fatalf("OpenIndex() error: %v", err)
	}
	defer idx.Close()

	ids, err := idx.SearchBodyIDs("old body")
	if err != nil {
		t.Fatalf("SearchBodyIDs(old) error: %v", err)
	}
	if len(ids) != 1 {
		t.Fatalf("SearchBodyIDs(old) len = %d, want 1", len(ids))
	}

	time.Sleep(10 * time.Millisecond)
	fiber.Body = "new body"
	if err := storage.Write(fiber); err != nil {
		t.Fatalf("Write(updated) error: %v", err)
	}
	if err := idx.Sync(storage); err != nil {
		t.Fatalf("Sync() error: %v", err)
	}

	oldIDs, err := idx.SearchBodyIDs("old body")
	if err != nil {
		t.Fatalf("SearchBodyIDs(old after sync) error: %v", err)
	}
	if len(oldIDs) != 0 {
		t.Fatalf("old body still indexed: %v", oldIDs)
	}

	newIDs, err := idx.SearchBodyIDs("new body")
	if err != nil {
		t.Fatalf("SearchBodyIDs(new) error: %v", err)
	}
	if len(newIDs) != 1 || newIDs[0] != "fiber-a" {
		t.Fatalf("SearchBodyIDs(new) = %v, want [fiber-a]", newIDs)
	}
}

func TestIndexSyncReindexesWhenNewTargetMakesRefResolvable(t *testing.T) {
	dir := t.TempDir()
	storage := NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	baseTime := time.Date(2026, 4, 10, 9, 0, 0, 0, time.UTC)
	if err := storage.Write(&Felt{
		ID:        "project/analysis",
		Name:      "Analysis",
		CreatedAt: baseTime,
		Body:      "See [[question]].",
	}); err != nil {
		t.Fatalf("Write(analysis) error: %v", err)
	}

	idx, err := storage.OpenIndex()
	if err != nil {
		t.Fatalf("OpenIndex() error: %v", err)
	}
	defer idx.Close()

	if err := storage.Write(&Felt{
		ID:        "project/question",
		Name:      "Question",
		CreatedAt: baseTime,
	}); err != nil {
		t.Fatalf("Write(question) error: %v", err)
	}
	if err := idx.Sync(storage); err != nil {
		t.Fatalf("Sync() error: %v", err)
	}

	citations, err := idx.Citations("project/question")
	if err != nil {
		t.Fatalf("Citations() error: %v", err)
	}
	if len(citations) != 1 || citations[0].SourceID != "project/analysis" {
		t.Fatalf("Citations(project/question) = %#v, want source project/analysis", citations)
	}
}

func TestIndexSyncReindexesWhenTargetDeletionChangesScopedResolution(t *testing.T) {
	dir := t.TempDir()
	storage := NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	baseTime := time.Date(2026, 4, 10, 9, 0, 0, 0, time.UTC)
	for _, fiber := range []*Felt{
		{
			ID:        "project/question",
			Name:      "Project Question",
			CreatedAt: baseTime,
		},
		{
			ID:        "project/analysis",
			Name:      "Analysis",
			CreatedAt: baseTime,
			Body:      "See [[question]].",
		},
	} {
		if err := storage.Write(fiber); err != nil {
			t.Fatalf("Write(%s) error: %v", fiber.ID, err)
		}
	}

	idx, err := storage.OpenIndex()
	if err != nil {
		t.Fatalf("OpenIndex() error: %v", err)
	}
	defer idx.Close()

	before, err := idx.Citations("project/question")
	if err != nil {
		t.Fatalf("Citations(project/question) before delete: %v", err)
	}
	if len(before) != 1 || before[0].SourceID != "project/analysis" {
		t.Fatalf("Citations(project/question) before delete = %#v, want source project/analysis", before)
	}

	if err := storage.Delete("project/question"); err != nil {
		t.Fatalf("Delete(project/question) error: %v", err)
	}
	if err := storage.Write(&Felt{
		ID:        "question",
		Name:      "Root Question",
		CreatedAt: baseTime,
	}); err != nil {
		t.Fatalf("Write(question) error: %v", err)
	}
	if err := idx.Sync(storage); err != nil {
		t.Fatalf("Sync() after delete error: %v", err)
	}

	afterProject, err := idx.Citations("project/question")
	if err != nil {
		t.Fatalf("Citations(project/question) after delete: %v", err)
	}
	if len(afterProject) != 0 {
		t.Fatalf("Citations(project/question) after delete = %#v, want none", afterProject)
	}

	afterRoot, err := idx.Citations("question")
	if err != nil {
		t.Fatalf("Citations(question) after delete: %v", err)
	}
	if len(afterRoot) != 1 || afterRoot[0].SourceID != "project/analysis" {
		t.Fatalf("Citations(question) after delete = %#v, want source project/analysis", afterRoot)
	}
}
