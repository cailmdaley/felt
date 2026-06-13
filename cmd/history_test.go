package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestHistoryReadDoesNotSyncFiberIndex(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	if err := storage.Write(&felt.Felt{
		ID:        "fiber-a",
		Name:      "Fiber A",
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
	}); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	reset := saveHistoryGlobals()
	defer reset()

	if out, err := runCommand(t, dir, "history", "append", "fiber-a", "--summary", "landed the fix"); err != nil {
		t.Fatalf("history append: %v\n%s", err, out)
	}
	writeMalformedFiber(t, dir)

	out, err := runCommand(t, dir, "history", "fiber-a", "--last", "1")
	if err != nil {
		t.Fatalf("history read should not sync unrelated fibers: %v\n%s", err, out)
	}
	if !strings.Contains(out, "landed the fix") {
		t.Fatalf("history read missing event:\n%s", out)
	}
}

func TestHistoryReadDoesNotCreateIndexWhenMissing(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	if err := storage.Write(&felt.Felt{
		ID:        "fiber-a",
		Name:      "Fiber A",
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
	}); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	reset := saveHistoryGlobals()
	defer reset()

	out, err := runCommand(t, dir, "history", "fiber-a", "--last", "1")
	if err != nil {
		t.Fatalf("history read: %v\n%s", err, out)
	}
	if !strings.Contains(out, "(no history events recorded)") {
		t.Fatalf("history read output mismatch:\n%s", out)
	}
	if _, err := os.Stat(dir + "/.felt/index.db"); !os.IsNotExist(err) {
		t.Fatalf("history read should not create index.db, stat err = %v", err)
	}
}

func TestHistoryReadValidatesFiltersWhenIndexMissing(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	if err := storage.Write(&felt.Felt{
		ID:        "fiber-a",
		Name:      "Fiber A",
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
	}); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	reset := saveHistoryGlobals()
	defer reset()

	out, err := runCommand(t, dir, "history", "fiber-a", "--since", "not-a-time")
	if err == nil {
		t.Fatalf("expected invalid --since to fail without index, got output:\n%s", out)
	}
	if !strings.Contains(err.Error(), "--since") {
		t.Fatalf("unexpected error: %v\n%s", err, out)
	}
	if _, err := os.Stat(dir + "/.felt/index.db"); !os.IsNotExist(err) {
		t.Fatalf("history read should not create index.db, stat err = %v", err)
	}
}

func TestShowDefaultDoesNotSyncFiberIndex(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	if err := storage.Write(&felt.Felt{
		ID:        "fiber-a",
		Name:      "Fiber A",
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
		Body:      "Body paragraph.",
	}); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	resetShow := saveShowGlobals()
	defer resetShow()
	resetHistory := saveHistoryGlobals()
	defer resetHistory()

	if out, err := runCommand(t, dir, "history", "append", "fiber-a", "--summary", "visible recent note"); err != nil {
		t.Fatalf("history append: %v\n%s", err, out)
	}
	writeMalformedFiber(t, dir)

	out, err := runCommand(t, dir, "show", "fiber-a")
	if err != nil {
		t.Fatalf("show should not sync unrelated fibers: %v\n%s", err, out)
	}
	for _, want := range []string{"Fiber A", "visible recent note", "Body paragraph."} {
		if !strings.Contains(out, want) {
			t.Fatalf("show missing %q:\n%s", want, out)
		}
	}
}

func TestHistoryBackfillAnchorsEventlessFibers(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	createdAt := mustParseTime(t, "2026-02-01T08:00:00Z")
	// `fresh` has no events and must gain one. `prior` already has an event and
	// must be left untouched.
	if err := storage.Write(&felt.Felt{
		ID:        "fresh",
		Name:      "Fresh fiber",
		CreatedAt: createdAt,
	}); err != nil {
		t.Fatalf("Write(fresh): %v", err)
	}
	if err := storage.Write(&felt.Felt{
		ID:        "prior",
		Name:      "Prior fiber",
		CreatedAt: createdAt,
	}); err != nil {
		t.Fatalf("Write(prior): %v", err)
	}

	priorEventAt := mustParseTime(t, "2026-05-05T12:00:00Z")
	func() {
		idx, err := storage.OpenIndexNoSync()
		if err != nil {
			t.Fatalf("OpenIndexNoSync: %v", err)
		}
		defer idx.Close()
		if err := idx.AppendEvent(felt.Event{
			FiberID:    "prior",
			OccurredAt: priorEventAt,
			Type:       felt.EventEditorial,
			Actor:      "test",
			Payload:    map[string]interface{}{felt.EditorialTextKey: "existing note"},
		}); err != nil {
			t.Fatalf("seed prior event: %v", err)
		}
	}()

	reset := saveHistoryGlobals()
	defer reset()

	out, err := runCommand(t, dir, "history", "backfill")
	if err != nil {
		t.Fatalf("history backfill: %v\n%s", err, out)
	}
	if !strings.Contains(out, "Anchored fresh") || !strings.Contains(out, "Anchored 1 fibers") {
		t.Fatalf("backfill output unexpected:\n%s", out)
	}
	if strings.Contains(out, "Anchored prior") {
		t.Fatalf("backfill touched a fiber that already had events:\n%s", out)
	}

	freshEvents := readEvents(t, storage, "fresh")
	if len(freshEvents) != 1 {
		t.Fatalf("fresh should have exactly 1 event, got %d", len(freshEvents))
	}
	ev := freshEvents[0]
	if ev.Type != felt.EventAdd {
		t.Fatalf("backfill event type = %q, want %q", ev.Type, felt.EventAdd)
	}
	if ev.Actor != "backfill" {
		t.Fatalf("backfill event actor = %q, want backfill", ev.Actor)
	}
	if !ev.OccurredAt.Equal(createdAt) {
		t.Fatalf("backfill event at %v, want created-at %v", ev.OccurredAt, createdAt)
	}
	if ev.Payload["backfill"] != true || ev.Payload["bootstrap"] != true {
		t.Fatalf("backfill payload missing markers: %v", ev.Payload)
	}
	if ev.ContentHash == "" {
		t.Fatalf("backfill event missing content hash")
	}

	// `prior` must still have exactly its one pre-existing event.
	priorEvents := readEvents(t, storage, "prior")
	if len(priorEvents) != 1 || priorEvents[0].Type != felt.EventEditorial {
		t.Fatalf("prior fiber altered by backfill: %+v", priorEvents)
	}

	// Idempotent: a second run anchors nothing.
	out, err = runCommand(t, dir, "history", "backfill")
	if err != nil {
		t.Fatalf("second backfill: %v\n%s", err, out)
	}
	if !strings.Contains(out, "No history backfill needed") {
		t.Fatalf("second backfill should be a no-op:\n%s", out)
	}
	if got := len(readEvents(t, storage, "fresh")); got != 1 {
		t.Fatalf("fresh gained events on second run: %d", got)
	}
}

func TestHistoryBackfillDryRunWritesNothing(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	if err := storage.Write(&felt.Felt{
		ID:        "fresh",
		Name:      "Fresh fiber",
		CreatedAt: mustParseTime(t, "2026-02-01T08:00:00Z"),
	}); err != nil {
		t.Fatalf("Write(fresh): %v", err)
	}

	reset := saveHistoryGlobals()
	defer reset()

	out, err := runCommand(t, dir, "history", "backfill", "--dry-run")
	if err != nil {
		t.Fatalf("history backfill --dry-run: %v\n%s", err, out)
	}
	if !strings.Contains(out, "Would anchor fresh") || !strings.Contains(out, "Dry run: 1 fibers") {
		t.Fatalf("dry-run output unexpected:\n%s", out)
	}
	if got := len(readEvents(t, storage, "fresh")); got != 0 {
		t.Fatalf("dry-run wrote %d events, want 0", got)
	}
}

// readEvents returns all history events for a fiber, oldest first.
func readEvents(t *testing.T, storage *felt.Storage, fiberID string) []felt.Event {
	t.Helper()
	idx, err := storage.OpenIndexReadOnly()
	if err != nil {
		t.Fatalf("OpenIndexReadOnly: %v", err)
	}
	defer idx.Close()
	events, err := idx.QueryEvents(felt.EventFilter{FiberID: fiberID})
	if err != nil {
		t.Fatalf("QueryEvents(%s): %v", fiberID, err)
	}
	return events
}

func writeMalformedFiber(t *testing.T, dir string) {
	t.Helper()
	badDir := filepath.Join(dir, ".felt", "broken", "broken")
	if err := os.MkdirAll(badDir, 0755); err != nil {
		t.Fatalf("MkdirAll malformed fiber dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(badDir, "broken.md"), []byte("---\nname: Broken\n"), 0644); err != nil {
		t.Fatalf("WriteFile malformed fiber: %v", err)
	}
}

func writeInvalidYAMLFiber(t *testing.T, dir string) {
	t.Helper()
	badDir := filepath.Join(dir, ".felt", "broken-yaml", "broken-yaml")
	if err := os.MkdirAll(badDir, 0755); err != nil {
		t.Fatalf("MkdirAll invalid YAML fiber dir: %v", err)
	}
	content := []byte("---\nname: [\n---\nThis should only fail if the command walks every fiber.\n")
	if err := os.WriteFile(filepath.Join(badDir, "broken-yaml.md"), content, 0644); err != nil {
		t.Fatalf("WriteFile invalid YAML fiber: %v", err)
	}
}

func saveHistoryGlobals() func() {
	prevShowEditorial := histShowEditorial
	prevShowMechanical := histShowMechanical
	prevKindFilter := histKindFilter
	prevLast := histLast
	prevSince := histSince
	prevUntil := histUntil
	prevAppendSummary := histAppendSummary
	prevAppendActor := histAppendActor
	prevAppendEditFrom := histAppendEditFrom
	prevAppendEditTo := histAppendEditTo
	prevAppendKind := histAppendKind
	prevAppendFields := histAppendFields
	prevBackfillDryRun := histBackfillDryRun
	prevJSON := jsonOutput

	histShowEditorial = true
	histShowMechanical = false
	histKindFilter = ""
	histLast = 0
	histSince = ""
	histUntil = ""
	histAppendSummary = ""
	histAppendActor = ""
	histAppendEditFrom = ""
	histAppendEditTo = ""
	histAppendKind = ""
	histAppendFields = nil
	histBackfillDryRun = false
	jsonOutput = false

	return func() {
		histShowEditorial = prevShowEditorial
		histShowMechanical = prevShowMechanical
		histKindFilter = prevKindFilter
		histLast = prevLast
		histSince = prevSince
		histUntil = prevUntil
		histAppendSummary = prevAppendSummary
		histAppendActor = prevAppendActor
		histAppendEditFrom = prevAppendEditFrom
		histAppendEditTo = prevAppendEditTo
		histAppendKind = prevAppendKind
		histAppendFields = prevAppendFields
		histBackfillDryRun = prevBackfillDryRun
		jsonOutput = prevJSON
	}
}
