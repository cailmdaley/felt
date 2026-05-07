package felt

import (
	"errors"
	"os"
	"sync"
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
			Inputs: []FiberInput{
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

func TestOpenIndexWaitsForConcurrentWriter(t *testing.T) {
	dir := t.TempDir()
	storage := NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	baseTime := time.Date(2026, 4, 10, 9, 0, 0, 0, time.UTC)
	if err := storage.Write(&Felt{
		ID:        "fiber-a",
		Name:      "Fiber A",
		CreatedAt: baseTime,
	}); err != nil {
		t.Fatalf("Write(fiber-a) error: %v", err)
	}

	idx, err := storage.OpenIndex()
	if err != nil {
		t.Fatalf("OpenIndex() error: %v", err)
	}
	defer idx.Close()

	if _, err := idx.db.Exec(`BEGIN IMMEDIATE`); err != nil {
		t.Fatalf("BEGIN IMMEDIATE error: %v", err)
	}
	t.Cleanup(func() {
		_, _ = idx.db.Exec(`ROLLBACK`)
	})

	if err := storage.Write(&Felt{
		ID:        "fiber-b",
		Name:      "Fiber B",
		CreatedAt: baseTime.Add(time.Minute),
	}); err != nil {
		t.Fatalf("Write(fiber-b) error: %v", err)
	}

	done := make(chan error, 1)
	go func() {
		second, err := storage.OpenIndex()
		if err == nil {
			err = second.Close()
		}
		done <- err
	}()

	time.Sleep(150 * time.Millisecond)
	if _, err := idx.db.Exec(`COMMIT`); err != nil {
		t.Fatalf("COMMIT error: %v", err)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("concurrent OpenIndex() error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("concurrent OpenIndex() did not complete after writer released lock")
	}
}

func TestOpenIndexRetriesAfterBusyTimeout(t *testing.T) {
	setIndexBusyTimings(t, 25*time.Millisecond, []time.Duration{
		25 * time.Millisecond,
		50 * time.Millisecond,
		100 * time.Millisecond,
	})

	dir := t.TempDir()
	storage := NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	baseTime := time.Date(2026, 4, 10, 9, 0, 0, 0, time.UTC)
	if err := storage.Write(&Felt{
		ID:        "fiber-a",
		Name:      "Fiber A",
		CreatedAt: baseTime,
	}); err != nil {
		t.Fatalf("Write(fiber-a) error: %v", err)
	}

	idx, err := storage.OpenIndex()
	if err != nil {
		t.Fatalf("OpenIndex() error: %v", err)
	}
	defer idx.Close()

	if _, err := idx.db.Exec(`BEGIN IMMEDIATE`); err != nil {
		t.Fatalf("BEGIN IMMEDIATE error: %v", err)
	}
	t.Cleanup(func() {
		_, _ = idx.db.Exec(`ROLLBACK`)
	})

	if err := storage.Write(&Felt{
		ID:        "fiber-b",
		Name:      "Fiber B",
		CreatedAt: baseTime.Add(time.Minute),
	}); err != nil {
		t.Fatalf("Write(fiber-b) error: %v", err)
	}

	done := make(chan error, 1)
	go func() {
		second, err := storage.OpenIndex()
		if err == nil {
			err = second.Close()
		}
		done <- err
	}()

	time.Sleep(75 * time.Millisecond)
	if _, err := idx.db.Exec(`COMMIT`); err != nil {
		t.Fatalf("COMMIT error: %v", err)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("concurrent OpenIndex() error after retry: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("concurrent OpenIndex() did not complete after writer released lock")
	}
}

func TestOpenIndexReturnsErrIndexBusyAfterRetriesExhausted(t *testing.T) {
	setIndexBusyTimings(t, 10*time.Millisecond, []time.Duration{
		5 * time.Millisecond,
		10 * time.Millisecond,
	})

	dir := t.TempDir()
	storage := NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	if err := storage.Write(&Felt{
		ID:        "fiber-a",
		Name:      "Fiber A",
		CreatedAt: time.Date(2026, 4, 10, 9, 0, 0, 0, time.UTC),
	}); err != nil {
		t.Fatalf("Write(fiber-a) error: %v", err)
	}

	idx, err := storage.OpenIndex()
	if err != nil {
		t.Fatalf("OpenIndex() error: %v", err)
	}
	defer idx.Close()

	if _, err := idx.db.Exec(`BEGIN IMMEDIATE`); err != nil {
		t.Fatalf("BEGIN IMMEDIATE error: %v", err)
	}
	t.Cleanup(func() {
		_, _ = idx.db.Exec(`ROLLBACK`)
	})

	if err := storage.Write(&Felt{
		ID:        "fiber-b",
		Name:      "Fiber B",
		CreatedAt: time.Date(2026, 4, 10, 10, 0, 0, 0, time.UTC),
	}); err != nil {
		t.Fatalf("Write(fiber-b) error: %v", err)
	}

	second, err := storage.OpenIndex()
	if second != nil {
		_ = second.Close()
	}
	if !errors.Is(err, ErrIndexBusy) {
		t.Fatalf("OpenIndex() error = %v, want ErrIndexBusy", err)
	}
}

func TestOpenIndexNoSyncRetriesAfterBusyTimeout(t *testing.T) {
	setIndexBusyTimings(t, 25*time.Millisecond, []time.Duration{
		25 * time.Millisecond,
		50 * time.Millisecond,
		100 * time.Millisecond,
	})

	dir := t.TempDir()
	storage := NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	if err := storage.Write(&Felt{
		ID:        "fiber-a",
		Name:      "Fiber A",
		CreatedAt: time.Date(2026, 4, 10, 9, 0, 0, 0, time.UTC),
	}); err != nil {
		t.Fatalf("Write(fiber-a) error: %v", err)
	}

	idx, err := storage.OpenIndex()
	if err != nil {
		t.Fatalf("OpenIndex() error: %v", err)
	}
	defer idx.Close()

	if _, err := idx.db.Exec(`BEGIN IMMEDIATE`); err != nil {
		t.Fatalf("BEGIN IMMEDIATE error: %v", err)
	}
	t.Cleanup(func() {
		_, _ = idx.db.Exec(`ROLLBACK`)
	})

	done := make(chan error, 1)
	go func() {
		second, err := storage.OpenIndexNoSync()
		if err == nil {
			err = second.Close()
		}
		done <- err
	}()

	time.Sleep(75 * time.Millisecond)
	if _, err := idx.db.Exec(`COMMIT`); err != nil {
		t.Fatalf("COMMIT error: %v", err)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("concurrent OpenIndexNoSync() error after retry: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("concurrent OpenIndexNoSync() did not complete after writer released lock")
	}
}

func TestConcurrentOpenIndexCleanFastPath(t *testing.T) {
	dir := t.TempDir()
	storage := NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	baseTime := time.Date(2026, 4, 10, 9, 0, 0, 0, time.UTC)
	for _, fiber := range []*Felt{
		{ID: "fiber-a", Name: "Fiber A", CreatedAt: baseTime},
		{ID: "fiber-b", Name: "Fiber B", CreatedAt: baseTime.Add(time.Minute)},
	} {
		if err := storage.Write(fiber); err != nil {
			t.Fatalf("Write(%s) error: %v", fiber.ID, err)
		}
	}

	idx, err := storage.OpenIndex()
	if err != nil {
		t.Fatalf("OpenIndex() error: %v", err)
	}
	if err := idx.Close(); err != nil {
		t.Fatalf("Close() error: %v", err)
	}

	var wg sync.WaitGroup
	errs := make(chan error, 16)
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			idx, err := storage.OpenIndex()
			if err != nil {
				errs <- err
				return
			}
			if err := idx.Close(); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)

	for err := range errs {
		t.Fatalf("concurrent clean OpenIndex() error: %v", err)
	}
}

func TestIndexSyncDoesNotInventExternalEditAfterTypedEditorial(t *testing.T) {
	dir := t.TempDir()
	storage := NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	baseTime := time.Date(2026, 4, 10, 9, 0, 0, 0, time.UTC)
	fiber := &Felt{
		ID:        "fiber-a",
		Name:      "Fiber A",
		CreatedAt: baseTime,
		Body:      "before",
	}
	if err := storage.Write(fiber); err != nil {
		t.Fatalf("Write(fiber-a) error: %v", err)
	}

	idx, err := storage.OpenIndex()
	if err != nil {
		t.Fatalf("OpenIndex() error: %v", err)
	}
	defer idx.Close()

	time.Sleep(10 * time.Millisecond)
	fiber.Body = "after"
	if err := storage.Write(fiber); err != nil {
		t.Fatalf("Write(updated fiber-a) error: %v", err)
	}
	data, err := os.ReadFile(storage.Path("fiber-a"))
	if err != nil {
		t.Fatalf("ReadFile(updated fiber-a) error: %v", err)
	}
	hash := HashBytes(data)
	eventTime := time.Now().UTC().Add(time.Minute)
	if err := idx.AppendEvent(Event{
		FiberID:     "fiber-a",
		OccurredAt:  eventTime,
		Type:        EventEdit,
		Actor:       "test-agent",
		ContentHash: hash,
	}); err != nil {
		t.Fatalf("AppendEvent edit: %v", err)
	}
	if err := idx.AppendEvent(Event{
		FiberID:    "fiber-a",
		OccurredAt: eventTime.Add(time.Minute),
		Type:       "review-comment",
		Actor:      "test-reviewer",
		Payload:    map[string]interface{}{"text": "looks good"},
	}); err != nil {
		t.Fatalf("AppendEvent typed editorial: %v", err)
	}

	if err := idx.Sync(storage); err != nil {
		t.Fatalf("Sync() error: %v", err)
	}
	external, err := idx.QueryEvents(EventFilter{
		FiberID: "fiber-a",
		Types:   []string{EventExternalEdit},
	})
	if err != nil {
		t.Fatalf("QueryEvents external_edit: %v", err)
	}
	if len(external) != 0 {
		t.Fatalf("Sync recorded external_edit after typed editorial: %#v", external)
	}
}

func setIndexBusyTimings(t *testing.T, timeout time.Duration, delays []time.Duration) {
	t.Helper()
	oldBusyTimeout := indexBusyTimeout
	oldRetryDelays := indexSyncRetryDelays
	indexBusyTimeout = timeout
	indexSyncRetryDelays = delays
	t.Cleanup(func() {
		indexBusyTimeout = oldBusyTimeout
		indexSyncRetryDelays = oldRetryDelays
	})
}
