package tapestry

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestSpecName(t *testing.T) {
	tests := []struct {
		name string
		tags []string
		want string
	}{
		{name: "missing", tags: []string{"spec"}, want: ""},
		{name: "present", tags: []string{"science", "tapestry:cosebis_data_vector"}, want: "cosebis_data_vector"},
		{name: "empty suffix", tags: []string{"tapestry:"}, want: ""},
	}

	for _, tt := range tests {
		if got := SpecName(tt.tags); got != tt.want {
			t.Errorf("%s: SpecName() = %q, want %q", tt.name, got, tt.want)
		}
	}
}

func TestReadEvidenceFiltersArtifacts(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "results", "tapestry", "spec-a")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("MkdirAll() error: %v", err)
	}

	content := `{
  "evidence": {"snr": 5.4},
  "output": {
    "figure": "plot.png",
    "table": "results.csv",
    "paper": "appendix.PDF"
  },
  "generated": "2026-03-14T12:00:00Z"
}`
	if err := os.WriteFile(filepath.Join(dir, "evidence.json"), []byte(content), 0644); err != nil {
		t.Fatalf("WriteFile() error: %v", err)
	}

	evidence, err := ReadEvidence(root, "spec-a")
	if err != nil {
		t.Fatalf("ReadEvidence() error: %v", err)
	}
	if evidence == nil {
		t.Fatal("ReadEvidence() = nil, want evidence")
	}
	if len(evidence.Artifacts) != 2 {
		t.Fatalf("Artifacts count = %d, want 2", len(evidence.Artifacts))
	}
	if evidence.Artifacts["figure"] != "plot.png" {
		t.Errorf("figure artifact = %q, want plot.png", evidence.Artifacts["figure"])
	}
	if evidence.Artifacts["paper"] != "appendix.PDF" {
		t.Errorf("paper artifact = %q, want appendix.PDF", evidence.Artifacts["paper"])
	}
	if _, ok := evidence.Artifacts["table"]; ok {
		t.Error("table artifact should have been filtered out")
	}
	if evidence.ArtifactPaths["figure"] != filepath.Join(root, "results", "tapestry", "spec-a", "plot.png") {
		t.Errorf("ArtifactPaths[figure] = %q", evidence.ArtifactPaths["figure"])
	}
	if evidence.Generated != "2026-03-14T12:00:00Z" {
		t.Errorf("Generated = %q, want 2026-03-14T12:00:00Z", evidence.Generated)
	}
	if evidence.MTime == 0 {
		t.Error("MTime = 0, want file mtime")
	}
}

func TestComputeStaleness(t *testing.T) {
	now := time.Date(2026, 3, 14, 12, 0, 0, 0, time.UTC)
	felts := []*felt.Felt{
		{
			ID:        "a-11111111",
			Title:     "A",
			CreatedAt: now,
		},
		{
			ID:        "b-22222222",
			Title:     "B",
			CreatedAt: now,
			DependsOn: felt.Dependencies{{ID: "a-11111111"}},
		},
		{
			ID:        "c-33333333",
			Title:     "C",
			CreatedAt: now,
			DependsOn: felt.Dependencies{{ID: "b-22222222"}},
		},
	}
	graph := felt.BuildGraph(felts)

	evidence := map[string]*Evidence{
		"a-11111111": {MTime: 20},
		"b-22222222": {MTime: 10},
	}
	if got := ComputeStaleness("b-22222222", graph, evidence); got != "stale" {
		t.Errorf("stale case = %q, want stale", got)
	}
	if got := ComputeStaleness("c-33333333", graph, evidence); got != "no-evidence" {
		t.Errorf("no-evidence case = %q, want no-evidence", got)
	}

	evidence["b-22222222"] = &Evidence{MTime: 30}
	if got := ComputeStaleness("b-22222222", graph, evidence); got != "fresh" {
		t.Errorf("fresh case = %q, want fresh", got)
	}
}
