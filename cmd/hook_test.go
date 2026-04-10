package cmd

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestMinimalOutput(t *testing.T) {
	output := minimalOutput()

	// Check header
	if !strings.Contains(output, "# Felt Workflow Context") {
		t.Error("missing header")
	}

	// Check no repository message
	if !strings.Contains(output, "No felt repository") {
		t.Error("missing no repository message")
	}

	// Check CLI reference
	if !strings.Contains(output, "## CLI") {
		t.Error("missing CLI reference")
	}

	// Check core rules
	if !strings.Contains(output, "## Core Rules") {
		t.Error("missing core rules section")
	}
}

func TestFormatSessionOutput(t *testing.T) {
	now := time.Now()
	closedTime := now.Add(-time.Hour)

	// Create test felts
	activeFelt := &felt.Felt{
		ID:     "active-task-12345678",
		Name:   "Active task",
		Status: felt.StatusActive,

		CreatedAt: now,
	}

	openFelt := &felt.Felt{
		ID:         "open-task-87654321",
		Name:       "Open task",
		Status:     felt.StatusOpen,
		CreatedAt:  now,
		ModifiedAt: now.Add(-30 * time.Minute),
	}

	closedFelt := &felt.Felt{
		ID:         "closed-task-abcdef12",
		Name:       "Closed task",
		Status:     felt.StatusClosed,
		CreatedAt:  now.Add(-2 * time.Hour),
		ClosedAt:   &closedTime,
		Outcome:    "Done with good results",
		ModifiedAt: closedTime,
	}

	felts := []*felt.Felt{activeFelt, openFelt, closedFelt}
	output := formatSessionOutput(felts)

	// Check header
	if !strings.Contains(output, "# Felt Workflow Context") {
		t.Error("missing header")
	}

	// Check active section
	if !strings.Contains(output, "## Active Fibers") {
		t.Error("missing active fibers section")
	}
	if !strings.Contains(output, "◐ active-task-12345678\n    Active task") {
		t.Error("missing active task entry")
	}

	// Check recently touched section
	if !strings.Contains(output, "## Recently Touched") {
		t.Error("missing recently touched section")
	}
	if !strings.Contains(output, "○ open-task-87654321\n    Open task") {
		t.Error("missing open task in recently touched")
	}
	if !strings.Contains(output, "● closed-task-abcdef12") {
		t.Error("missing closed task in recently touched")
	}
	if !strings.Contains(output, "→ Done with good results") {
		t.Error("missing outcome")
	}

	// Check core rules
	if !strings.Contains(output, "## Core Rules") {
		t.Error("missing core rules section")
	}
}

func TestFormatSessionOutput_Empty(t *testing.T) {
	felts := []*felt.Felt{}
	output := formatSessionOutput(felts)

	// Should show empty message
	if !strings.Contains(output, "No active fibers") {
		t.Error("missing empty state message")
	}
}

func TestFormatSessionOutput_RecentlyTouchedOmitsActive(t *testing.T) {
	now := time.Now()

	active := &felt.Felt{
		ID:         "active-task-12345678",
		Name:       "Active task",
		Status:     felt.StatusActive,
		CreatedAt:  now,
		ModifiedAt: now,
	}
	closed := &felt.Felt{
		ID:         "closed-task-87654321",
		Name:       "Closed task",
		Status:     felt.StatusClosed,
		CreatedAt:  now.Add(-time.Hour),
		ModifiedAt: now.Add(-time.Minute),
	}

	output := formatSessionOutput([]*felt.Felt{active, closed})
	if strings.Count(output, "active-task-12345678") != 1 {
		t.Fatalf("active fiber should appear once, got output:\n%s", output)
	}
}

func TestFormatSessionOutput_IncludesClosedRecentFibers(t *testing.T) {
	now := time.Now()
	closedTime := now.Add(-time.Hour)

	closedDepFelt := &felt.Felt{
		ID:         "closed-dep-12345678",
		Name:       "Completed prereq",
		Status:     felt.StatusClosed,
		CreatedAt:  now.Add(-2 * time.Hour),
		ClosedAt:   &closedTime,
		ModifiedAt: closedTime,
	}

	openFelt := &felt.Felt{
		ID:         "open-task-87654321",
		Name:       "Fresh open task",
		Status:     felt.StatusOpen,
		CreatedAt:  now.Add(time.Minute),
		ModifiedAt: now.Add(-2 * time.Minute),
	}

	felts := []*felt.Felt{closedDepFelt, openFelt}
	output := formatSessionOutput(felts)

	// The closed dependency should appear in recently touched
	if !strings.Contains(output, "## Recently Touched") {
		t.Error("missing recently touched section")
	}
	if !strings.Contains(output, "closed-dep-12345678") {
		t.Error("closed fiber should appear in recently touched")
	}
}

func TestFormatSessionOutput_DirectoryBasedStorageIDs(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	now := time.Now()
	closedTime := now.Add(-time.Hour)

	closedDep := &felt.Felt{
		ID:         "foundation/closed-dep",
		Name:       "Closed dep",
		Status:     felt.StatusClosed,
		CreatedAt:  now.Add(-2 * time.Hour),
		ClosedAt:   &closedTime,
		ModifiedAt: closedTime,
	}
	active := &felt.Felt{
		ID:        "analysis/active-task",
		Name:      "Active task",
		Status:    felt.StatusActive,
		CreatedAt: now,
	}
	open := &felt.Felt{
		ID:         "analysis/open-task",
		Name:       "Open task",
		Status:     felt.StatusOpen,
		CreatedAt:  now.Add(time.Minute),
		ModifiedAt: now.Add(-time.Minute),
	}

	for _, f := range []*felt.Felt{closedDep, active, open} {
		if err := storage.Write(f); err != nil {
			t.Fatalf("Write(%s) error: %v", f.ID, err)
		}
	}

	felts, err := storage.ListMetadataWithModTime()
	if err != nil {
		t.Fatalf("ListMetadataWithModTime() error: %v", err)
	}

	output := formatSessionOutput(felts)

	if !strings.Contains(output, "◐ analysis/active-task\n    Active task") {
		t.Fatalf("active nested fiber missing from session output:\n%s", output)
	}
	if !strings.Contains(output, "○ analysis/open-task\n    Open task") {
		t.Fatalf("open nested fiber missing from recent section:\n%s", output)
	}
	if !strings.Contains(output, "● foundation/closed-dep\n    Closed dep") {
		t.Fatalf("closed dependency missing from recent section:\n%s", output)
	}
}

func TestFormatSessionOutput_TagLabels(t *testing.T) {
	now := time.Now()

	// Create fibers with different tags
	taskFelt := &felt.Felt{
		ID:     "impl-auth-12345678",
		Name:   "Implement auth",
		Status: felt.StatusActive,

		CreatedAt: now,
	}

	decisionFelt := &felt.Felt{
		ID:     "design-api-87654321",
		Name:   "Design REST API",
		Status: felt.StatusOpen,
		Tags:   []string{"decision"},

		CreatedAt: now,
	}

	questionFelt := &felt.Felt{
		ID:     "research-lib-abcdef12",
		Name:   "Which library?",
		Status: felt.StatusOpen,
		Tags:   []string{"question"},

		CreatedAt: now,
	}

	felts := []*felt.Felt{taskFelt, decisionFelt, questionFelt}
	output := formatSessionOutput(felts)

	// Fiber with no tags should NOT have a tag label
	if strings.Contains(output, "(task)") {
		t.Error("fiber with no tags should not show label")
	}

	// Decision should have (decision) in metadata
	if !strings.Contains(output, "○ design-api-87654321\n    Design REST API (decision)") {
		t.Errorf("decision fiber should show (decision) label, got output:\n%s", output)
	}

	// Question should have (question) in metadata
	if !strings.Contains(output, "○ research-lib-abcdef12\n    Which library? (question)") {
		t.Errorf("question fiber should show (question) label, got output:\n%s", output)
	}
}

func TestFormatFeltTwoLine(t *testing.T) {
	tests := []struct {
		name     string
		felt     *felt.Felt
		expected string
	}{
		{
			name: "active - no tags",
			felt: &felt.Felt{
				ID:     "impl-auth-12345678",
				Name:   "Implement auth",
				Status: felt.StatusActive,
			},
			expected: "◐ impl-auth-12345678\n    Implement auth\n",
		},
		{
			name: "open - decision tag",
			felt: &felt.Felt{
				ID:     "design-api-87654321",
				Name:   "Design REST API",
				Status: felt.StatusOpen,
				Tags:   []string{"decision"},
			},
			expected: "○ design-api-87654321\n    Design REST API (decision)\n",
		},
		{
			name: "open - spec tag",
			felt: &felt.Felt{
				ID:     "api-spec-abcdef12",
				Name:   "API specification",
				Status: felt.StatusOpen,
				Tags:   []string{"spec"},
			},
			expected: "○ api-spec-abcdef12\n    API specification (spec)\n",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := formatFeltTwoLine(tt.felt)
			if result != tt.expected {
				t.Errorf("formatFeltTwoLine() = %q, want %q", result, tt.expected)
			}
		})
	}
}

func TestFormatSessionOutput_LimitsRecentlyTouched(t *testing.T) {
	now := time.Now()

	// Create 7 closed fibers with staggered mod times
	var felts []*felt.Felt
	for i := 0; i < 7; i++ {
		closedTime := now.Add(-time.Duration(i) * time.Hour)
		felts = append(felts, &felt.Felt{
			ID:         fmt.Sprintf("closed-%d-12345678", i),
			Name:       fmt.Sprintf("Closed task %d", i),
			Status:     felt.StatusClosed,
			ClosedAt:   &closedTime,
			CreatedAt:  now.Add(-10 * time.Hour),
			ModifiedAt: now.Add(-time.Duration(i) * time.Hour),
		})
	}

	output := formatSessionOutput(felts)

	// Should only show 5 most recent
	if strings.Contains(output, "closed-5-12345678") {
		t.Error("should not show 6th fiber")
	}
	if strings.Contains(output, "closed-6-12345678") {
		t.Error("should not show 7th fiber")
	}

	// Should show the 5 most recent
	if !strings.Contains(output, "closed-0-12345678") {
		t.Error("should show most recently modified fiber")
	}
	if !strings.Contains(output, "closed-4-12345678") {
		t.Error("should show 5th most recently modified fiber")
	}
}

func TestFormatRecentEntry(t *testing.T) {
	now := time.Now()

	tests := []struct {
		name        string
		felt        *felt.Felt
		wantIcon    string
		wantTag     bool
		wantOutcome bool
	}{
		{
			name: "basic closed with outcome",
			felt: &felt.Felt{
				ID:       "done-task-12345678",
				Name:     "Done task",
				Status:   felt.StatusClosed,
				Outcome:  "Completed successfully",
				ClosedAt: &now,
			},
			wantIcon:    "●",
			wantTag:     false,
			wantOutcome: true,
		},
		{
			name: "closed decision with tag label",
			felt: &felt.Felt{
				ID:       "decided-12345678",
				Name:     "Which approach",
				Status:   felt.StatusClosed,
				Tags:     []string{"decision"},
				Outcome:  "Chose option A because of performance",
				ClosedAt: &now,
			},
			wantIcon:    "●",
			wantTag:     true,
			wantOutcome: true,
		},
		{
			name: "closed without outcome",
			felt: &felt.Felt{
				ID:       "no-reason-12345678",
				Name:     "No reason given",
				Status:   felt.StatusClosed,
				ClosedAt: &now,
			},
			wantIcon:    "●",
			wantTag:     false,
			wantOutcome: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := formatRecentEntry(tt.felt)

			if !strings.Contains(result, tt.wantIcon) {
				t.Errorf("missing closed icon, got: %s", result)
			}

			if tt.wantTag && !strings.Contains(result, "(decision)") {
				t.Errorf("missing tag label, got: %s", result)
			}

			if !tt.wantTag && strings.Contains(result, "(decision)") {
				t.Error("should not show tag label when no tags")
			}

			if tt.wantOutcome && !strings.Contains(result, "→") {
				t.Error("missing outcome arrow")
			}

			if !tt.wantOutcome && strings.Contains(result, "→") {
				t.Error("should not have outcome arrow when no outcome")
			}
		})
	}
}

func TestFormatRecentEntry_TruncatesLongOutcome(t *testing.T) {
	now := time.Now()
	longOutcome := strings.Repeat("a", 150)

	f := &felt.Felt{
		ID:       "long-reason-12345678",
		Name:     "Long reason task",
		Outcome:  longOutcome,
		ClosedAt: &now,
	}

	result := formatRecentEntry(f)

	// Should be truncated with ...
	if !strings.Contains(result, "...") {
		t.Error("long outcome should be truncated with ...")
	}
	// Should not contain the full 150 chars
	if strings.Contains(result, longOutcome) {
		t.Error("should not contain full long outcome")
	}
}
