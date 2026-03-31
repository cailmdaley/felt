package tapestry

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestReadASTRA(t *testing.T) {
	root := t.TempDir()
	writeASTRAFixture(t, root)

	decisions, err := ReadASTRA(root)
	if err != nil {
		t.Fatalf("ReadASTRA() error: %v", err)
	}

	want := []Decision{
		{
			ID:          "shear_frame",
			Label:       "Shear reference frame",
			Rationale:   "Choose coordinates for gamma_x.\n",
			Tags:        []string{"coordinates", "tier_1"},
			Default:     "galaxy",
			AnalysisID:  "",
			EvidenceIDs: []string{},
			Options: []DecisionOption{
				{ID: "galaxy", Label: "Galaxy frame", Description: "No blind spot.\n"},
				{ID: "image", Label: "Image frame", Description: "Detector coordinates.\n", Excluded: true, ExcludedReason: "Blind spot at 45 degrees.\n"},
			},
			tapestryNodes: []string{"shear_reference_frame", "spin2_rotation"},
		},
		{
			ID:          "intensity_profile",
			Label:       "Galaxy intensity profile model",
			Rationale:   "Profile shapes the likelihood.\n",
			Tags:        []string{"galaxy_model", "tier_3"},
			Default:     "exponential",
			AnalysisID:  "build_mocks",
			EvidenceIDs: []string{},
			Options: []DecisionOption{
				{ID: "exponential", Label: "Exponential disk", Description: "Standard disk profile.\n"},
				{ID: "sersic", Label: "Sersic profile", Description: "Generalized morphology.\n", Excluded: true, ExcludedReason: "Not implemented.\n"},
			},
		},
		{
			ID:          "rotation_curve",
			Label:       "Galaxy rotation curve model",
			Rationale:   "Rotation curve affects shear sensitivity.\n",
			Tags:        []string{"galaxy_model", "tier_3"},
			Default:     "arctan",
			AnalysisID:  "build_mocks",
			EvidenceIDs: []string{},
			Options: []DecisionOption{
				{ID: "arctan", Label: "Arctan", Description: "Baseline rotation model.\n"},
			},
		},
	}

	if !reflect.DeepEqual(decisions, want) {
		t.Fatalf("ReadASTRA() = %#v, want %#v", decisions, want)
	}
}

func TestReadASTRAMissingFile(t *testing.T) {
	decisions, err := ReadASTRA(t.TempDir())
	if err != nil {
		t.Fatalf("ReadASTRA() error: %v", err)
	}
	if len(decisions) != 0 {
		t.Fatalf("len(ReadASTRA()) = %d, want 0", len(decisions))
	}
}

func TestWireEvidence(t *testing.T) {
	decisions := []Decision{
		{ID: "shear_frame", tapestryNodes: []string{"spin2_rotation", "shear_reference_frame"}},
		{ID: "rotation_curve"},
	}
	nodes := []Node{
		{ID: "fiber-b", SpecName: "spin2_rotation"},
		{ID: "fiber-a", SpecName: "shear_reference_frame"},
		{ID: "fiber-c", Tags: []string{"evidence:rotation_curve"}},
	}

	WireEvidence(decisions, nodes)

	if got, want := decisions[0].EvidenceIDs, []string{"fiber-a", "fiber-b"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("spec wiring = %#v, want %#v", got, want)
	}
	if got, want := decisions[1].EvidenceIDs, []string{"fiber-c"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("tag wiring = %#v, want %#v", got, want)
	}
}

func TestExportIncludesDecisions(t *testing.T) {
	root := t.TempDir()
	storage := felt.NewStorage(root)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	now := time.Date(2026, 3, 30, 12, 0, 0, 0, time.UTC)
	nodeA := &felt.Felt{
		ID:        "shear-reference-11111111",
		Title:     "Shear reference frame",
		Status:    felt.StatusClosed,
		Tags:      []string{"tapestry:shear_reference_frame"},
		CreatedAt: now,
		Outcome:   "Galaxy frame removes the blind spot.",
	}
	nodeB := &felt.Felt{
		ID:        "spin2-rotation-22222222",
		Title:     "Spin-2 rotation",
		Status:    felt.StatusClosed,
		Tags:      []string{"tapestry:spin2_rotation"},
		CreatedAt: now.Add(time.Minute),
		Outcome:   "Sign convention is fixed.",
	}
	for _, f := range []*felt.Felt{nodeA, nodeB} {
		if err := storage.Write(f); err != nil {
			t.Fatalf("Write() error: %v", err)
		}
	}

	writeASTRAFixture(t, root)

	outDir := filepath.Join(root, "export", "demo")
	if err := Export(root, outDir, ExportOptions{Name: "demo"}); err != nil {
		t.Fatalf("Export() error: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(outDir, "tapestry.json"))
	if err != nil {
		t.Fatalf("ReadFile() error: %v", err)
	}

	var payload exportPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatalf("json.Unmarshal() error: %v", err)
	}
	if len(payload.Decisions) != 3 {
		t.Fatalf("len(payload.Decisions) = %d, want 3", len(payload.Decisions))
	}
	if got, want := payload.Decisions[0].EvidenceIDs, []string{"shear-reference-11111111", "spin2-rotation-22222222"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("payload.Decisions[0].EvidenceIDs = %#v, want %#v", got, want)
	}
}

func writeASTRAFixture(t *testing.T, root string) {
	t.Helper()

	data, err := os.ReadFile(filepath.Join("testdata", "astra.yaml"))
	if err != nil {
		t.Fatalf("ReadFile(test fixture) error: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "astra.yaml"), data, 0644); err != nil {
		t.Fatalf("WriteFile(astra.yaml) error: %v", err)
	}
}
