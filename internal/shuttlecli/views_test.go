package shuttlecli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

// serial: feltcli's embedded ls and show print to the process stdout, which
// captureStdout swaps.
func TestShuttleViewsKeepResolvedFacetJSON(t *testing.T) {
	dir, storage := newStore(t)
	fiber := &felt.Felt{
		ID:        "work/task",
		UID:       "task-uid",
		Name:      "Task",
		Status:    felt.StatusActive,
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
	}
	if err := fiber.SetExtraField("shuttle", map[string]any{
		"agent":       "claude-opus",
		"effort":      "high",
		"host":        "test-host",
		"kind":        "oneshot",
		"project_dir": "/work/project",
		"runtime":     map[string]any{"session_id": "session-123"},
	}); err != nil {
		t.Fatalf("SetExtraField: %v", err)
	}
	if err := storage.Write(fiber); err != nil {
		t.Fatalf("Write: %v", err)
	}

	var err error
	listJSON := captureStdout(t, func() {
		_, err = runCommand(t, dir, "ls", "--json", "--has-field", "shuttle", "--json-field", "id,shuttle")
	})
	if err != nil {
		t.Fatalf("shuttle ls: %v", err)
	}
	golden, err := os.ReadFile(filepath.Join("testdata", "shuttle-views.json"))
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	if listJSON != string(golden) {
		t.Fatalf("shuttle ls JSON differs from golden\nwant:\n%s\ngot:\n%s", golden, listJSON)
	}

	showJSON := captureStdout(t, func() {
		_, err = runCommand(t, dir, "show", "work/task", "--json")
	})
	if err != nil {
		t.Fatalf("shuttle show: %v", err)
	}
	var rows []map[string]any
	var shown map[string]any
	if err := json.Unmarshal([]byte(listJSON), &rows); err != nil {
		t.Fatalf("decode shuttle ls JSON: %v", err)
	}
	if err := json.Unmarshal([]byte(showJSON), &shown); err != nil {
		t.Fatalf("decode shuttle show JSON: %v", err)
	}
	if len(rows) != 1 || !reflect.DeepEqual(rows[0]["shuttle"], shown["shuttle"]) {
		t.Fatalf("ls and show should emit the same resolved facet; ls=%#v show=%#v", rows, shown)
	}
	facet, ok := shown["shuttle"].(map[string]any)
	if !ok || facet["resolved"] == nil {
		t.Fatalf("resolved Shuttle facet missing from show JSON: %#v", shown["shuttle"])
	}
}
