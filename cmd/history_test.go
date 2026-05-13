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
		jsonOutput = prevJSON
	}
}
