package felt

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestHistoryBootstrapsAddEvent ensures Sync seeds a synthetic add
// event for fibers that exist on disk but have no history yet.
func TestHistoryBootstrapsAddEvent(t *testing.T) {
	dir := t.TempDir()
	storage := NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	f := &Felt{
		ID:        "alpha",
		Name:      "Alpha",
		CreatedAt: time.Date(2026, 4, 10, 9, 0, 0, 0, time.UTC),
		Body:      "first.",
	}
	if err := storage.Write(f); err != nil {
		t.Fatalf("Write: %v", err)
	}

	idx, err := storage.OpenIndex()
	if err != nil {
		t.Fatalf("OpenIndex: %v", err)
	}
	defer idx.Close()

	events, err := idx.QueryEvents(EventFilter{FiberID: "alpha"})
	if err != nil {
		t.Fatalf("QueryEvents: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 bootstrap event, got %d", len(events))
	}
	if events[0].Type != EventAdd {
		t.Fatalf("expected bootstrap add event, got %q", events[0].Type)
	}
	if events[0].Actor != "index-bootstrap" {
		t.Fatalf("expected actor index-bootstrap, got %q", events[0].Actor)
	}
	if events[0].ContentHash == "" {
		t.Fatal("expected non-empty content hash on bootstrap event")
	}
	if v, ok := events[0].Payload["bootstrap"]; !ok || v != true {
		t.Fatalf("expected bootstrap=true in payload, got %v", events[0].Payload)
	}
}

// TestHistoryDetectsExternalEdit verifies that mutating a fiber file
// outside the felt CLI causes the next Sync to record an external_edit
// event.
func TestHistoryDetectsExternalEdit(t *testing.T) {
	dir := t.TempDir()
	storage := NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}

	f := &Felt{
		ID:        "beta",
		Name:      "Beta",
		CreatedAt: time.Date(2026, 4, 10, 9, 0, 0, 0, time.UTC),
		Body:      "first body",
	}
	if err := storage.Write(f); err != nil {
		t.Fatalf("Write: %v", err)
	}

	// First sync seeds bootstrap event.
	idx, err := storage.OpenIndex()
	if err != nil {
		t.Fatalf("first OpenIndex: %v", err)
	}
	idx.Close()

	// Mutate the file directly (simulating vi).
	path := storage.Path("beta")
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	mutated := append(content, []byte("\nexternal patch\n")...)
	if err := os.WriteFile(path, mutated, 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	// Bump mtime so Sync notices it as a topology-or-mtime change. On
	// fast filesystems the second write can land in the same nanosecond
	// as the first; bump a little.
	future := time.Now().Add(time.Second)
	if err := os.Chtimes(path, future, future); err != nil {
		t.Fatalf("chtimes: %v", err)
	}

	idx2, err := storage.OpenIndex()
	if err != nil {
		t.Fatalf("second OpenIndex: %v", err)
	}
	defer idx2.Close()

	events, err := idx2.QueryEvents(EventFilter{FiberID: "beta"})
	if err != nil {
		t.Fatalf("QueryEvents: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("expected 2 events (bootstrap + external_edit), got %d:\n%+v", len(events), events)
	}
	if events[1].Type != EventExternalEdit {
		t.Fatalf("expected second event to be external_edit, got %q", events[1].Type)
	}
	if events[1].Actor != "external" {
		t.Fatalf("expected actor=external, got %q", events[1].Actor)
	}
	if events[1].ContentHash == "" || events[1].ContentHash == events[0].ContentHash {
		t.Fatalf("expected new hash on external_edit, got %q (prev=%q)",
			events[1].ContentHash, events[0].ContentHash)
	}
}

// TestHistoryNoSpuriousEditWhenHashStable confirms that subsequent
// syncs without file changes do not append redundant events.
func TestHistoryNoSpuriousEditWhenHashStable(t *testing.T) {
	dir := t.TempDir()
	storage := NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	if err := storage.Write(&Felt{
		ID:        "gamma",
		Name:      "Gamma",
		CreatedAt: time.Date(2026, 4, 10, 9, 0, 0, 0, time.UTC),
	}); err != nil {
		t.Fatalf("Write: %v", err)
	}

	// First sync seeds bootstrap.
	idx, err := storage.OpenIndex()
	if err != nil {
		t.Fatalf("OpenIndex: %v", err)
	}
	idx.Close()

	// Open again without touching the file.
	idx2, err := storage.OpenIndex()
	if err != nil {
		t.Fatalf("re-OpenIndex: %v", err)
	}
	defer idx2.Close()

	events, err := idx2.QueryEvents(EventFilter{FiberID: "gamma"})
	if err != nil {
		t.Fatalf("QueryEvents: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected exactly 1 event after stable resync, got %d", len(events))
	}
}

// TestEditorialEventRoundTrip writes an editorial event through the
// public AppendEvent API and reads it back via QueryEvents.
func TestEditorialEventRoundTrip(t *testing.T) {
	dir := t.TempDir()
	storage := NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	if err := storage.Write(&Felt{
		ID:        "delta",
		Name:      "Delta",
		CreatedAt: time.Date(2026, 4, 10, 9, 0, 0, 0, time.UTC),
	}); err != nil {
		t.Fatalf("Write: %v", err)
	}
	idx, err := storage.OpenIndex()
	if err != nil {
		t.Fatalf("OpenIndex: %v", err)
	}
	defer idx.Close()

	occurred := time.Date(2026, 4, 11, 10, 0, 0, 0, time.UTC)
	if err := idx.AppendEvent(Event{
		FiberID:    "delta",
		OccurredAt: occurred,
		Type:       EventEditorial,
		Actor:      "test-agent",
		Payload: map[string]interface{}{
			EditorialTextKey: "First editorial note.",
		},
	}); err != nil {
		t.Fatalf("AppendEvent: %v", err)
	}

	editorial, err := idx.QueryEvents(EventFilter{
		FiberID: "delta",
		Types:   []string{EventEditorial},
	})
	if err != nil {
		t.Fatalf("QueryEvents: %v", err)
	}
	if len(editorial) != 1 {
		t.Fatalf("expected 1 editorial event, got %d", len(editorial))
	}
	if editorial[0].Actor != "test-agent" {
		t.Fatalf("actor mismatch: %q", editorial[0].Actor)
	}
	if !editorial[0].OccurredAt.Equal(occurred) {
		t.Fatalf("occurred_at mismatch: got %v want %v",
			editorial[0].OccurredAt, occurred)
	}
	if got := editorial[0].Payload[EditorialTextKey]; got != "First editorial note." {
		t.Fatalf("text payload mismatch: %v", got)
	}

	// Editorial events do not change the latest mechanical hash.
	hash, err := idx.LatestMechanicalHash("delta")
	if err != nil {
		t.Fatalf("LatestMechanicalHash: %v", err)
	}
	if hash == "" {
		t.Fatal("expected a bootstrap hash, got empty")
	}
}

// TestTypedEditorialEventRoundTrip exercises filing + reading typed
// editorial events (e.g. "review-comment"). The append uses the same
// AppendEvent path as the CLI's `--kind` flag wires up, and the read
// uses the existing EventFilter.Types selector.
func TestTypedEditorialEventRoundTrip(t *testing.T) {
	dir := t.TempDir()
	storage := NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	if err := storage.Write(&Felt{
		ID:        "epsilon",
		Name:      "Epsilon",
		CreatedAt: time.Date(2026, 4, 12, 9, 0, 0, 0, time.UTC),
	}); err != nil {
		t.Fatalf("Write: %v", err)
	}
	idx, err := storage.OpenIndex()
	if err != nil {
		t.Fatalf("OpenIndex: %v", err)
	}
	defer idx.Close()

	// One regular editorial event (canonical "text" key) + one typed
	// review-comment event written with the legacy "summary" key, to
	// confirm the storage layer round-trips both shapes.
	if err := idx.AppendEvent(Event{
		FiberID:    "epsilon",
		OccurredAt: time.Date(2026, 4, 12, 10, 0, 0, 0, time.UTC),
		Type:       EventEditorial,
		Actor:      "test-worker",
		Payload:    map[string]interface{}{EditorialTextKey: "regular handoff"},
	}); err != nil {
		t.Fatalf("AppendEvent editorial: %v", err)
	}
	if err := idx.AppendEvent(Event{
		FiberID:    "epsilon",
		OccurredAt: time.Date(2026, 4, 12, 11, 0, 0, 0, time.UTC),
		Type:       "review-comment",
		Actor:      "test-cail",
		Payload:    map[string]interface{}{EditorialTextKeyLegacy: "use DES weights"},
	}); err != nil {
		t.Fatalf("AppendEvent review-comment: %v", err)
	}

	// Default editorial filter only returns the editorial event.
	editorial, err := idx.QueryEvents(EventFilter{
		FiberID: "epsilon",
		Types:   []string{EventEditorial},
	})
	if err != nil {
		t.Fatalf("QueryEvents editorial: %v", err)
	}
	if len(editorial) != 1 {
		t.Fatalf("expected 1 editorial-only event, got %d", len(editorial))
	}
	if got := editorial[0].Payload[EditorialTextKey]; got != "regular handoff" {
		t.Fatalf("editorial text mismatch: %v", got)
	}

	// --kind=review-comment selects only the typed event.
	directives, err := idx.QueryEvents(EventFilter{
		FiberID:    "epsilon",
		Types:      []string{"review-comment"},
		Descending: true,
		Limit:      1,
	})
	if err != nil {
		t.Fatalf("QueryEvents review-comment: %v", err)
	}
	if len(directives) != 1 {
		t.Fatalf("expected 1 review-comment event, got %d", len(directives))
	}
	if directives[0].Actor != "test-cail" {
		t.Fatalf("expected actor=test-cail, got %q", directives[0].Actor)
	}
	if got := directives[0].Payload[EditorialTextKeyLegacy]; got != "use DES weights" {
		t.Fatalf("legacy summary key mismatch: %v", got)
	}
}

func TestLatestMechanicalHashIgnoresTypedEditorialEvents(t *testing.T) {
	dir := t.TempDir()
	storage := NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	if err := storage.Write(&Felt{
		ID:        "zeta",
		Name:      "Zeta",
		CreatedAt: time.Date(2026, 4, 12, 9, 0, 0, 0, time.UTC),
		Body:      "first body",
	}); err != nil {
		t.Fatalf("Write: %v", err)
	}

	idx, err := storage.OpenIndex()
	if err != nil {
		t.Fatalf("OpenIndex: %v", err)
	}
	defer idx.Close()

	const editHash = "abc123"
	eventTime := time.Now().UTC().Add(time.Minute)
	if err := idx.AppendEvent(Event{
		FiberID:     "zeta",
		OccurredAt:  eventTime,
		Type:        EventEdit,
		Actor:       "test-agent",
		ContentHash: editHash,
	}); err != nil {
		t.Fatalf("AppendEvent edit: %v", err)
	}
	if err := idx.AppendEvent(Event{
		FiberID:    "zeta",
		OccurredAt: eventTime.Add(time.Minute),
		Type:       "review-comment",
		Actor:      "test-reviewer",
		Payload:    map[string]interface{}{"text": "please tighten this"},
	}); err != nil {
		t.Fatalf("AppendEvent typed editorial: %v", err)
	}

	hash, err := idx.LatestMechanicalHash("zeta")
	if err != nil {
		t.Fatalf("LatestMechanicalHash: %v", err)
	}
	if hash != editHash {
		t.Fatalf("LatestMechanicalHash = %q, want %q", hash, editHash)
	}
}

// TestDefaultActorShape confirms the actor format: $FELT_AGENT@<host>
// when set, plain <host> when not.
func TestDefaultActorShape(t *testing.T) {
	host, err := os.Hostname()
	if err != nil || host == "" {
		host = "unknown"
	}

	t.Setenv("FELT_AGENT", "")
	if got := DefaultActor(); got != host {
		t.Fatalf("expected hostname %q, got %q", host, got)
	}

	t.Setenv("FELT_AGENT", "claude-sonnet")
	want := "claude-sonnet@" + host
	if got := DefaultActor(); got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}

	// Whitespace-only FELT_AGENT falls through to host alone.
	t.Setenv("FELT_AGENT", "   ")
	if got := DefaultActor(); got != host {
		t.Fatalf("expected %q (whitespace agent ignored), got %q", host, got)
	}
}

// TestHashFileMatchesHashBytes ensures the two helpers agree.
func TestHashFileMatchesHashBytes(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "blob.txt")
	body := []byte("the quick brown fox\n")
	if err := os.WriteFile(path, body, 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	got, err := HashFile(path)
	if err != nil {
		t.Fatalf("HashFile: %v", err)
	}
	want := HashBytes(body)
	if got != want {
		t.Fatalf("hash mismatch: file=%s bytes=%s", got, want)
	}
	if !strings.HasPrefix(got, want[:8]) {
		t.Fatal("short prefix mismatch")
	}
}
