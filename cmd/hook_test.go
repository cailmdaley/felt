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
		ID:        "active-task-12345678",
		Title:     "Active task",
		Status:    felt.StatusActive,

		CreatedAt: now,
	}

	readyFelt := &felt.Felt{
		ID:        "ready-task-87654321",
		Title:     "Ready task",
		Status:    felt.StatusOpen,

		CreatedAt: now,
	}

	closedFelt := &felt.Felt{
		ID:         "closed-task-abcdef12",
		Title:      "Closed task",
		Status:     felt.StatusClosed,
		CreatedAt:  now.Add(-2 * time.Hour),
		ClosedAt:   &closedTime,
		Outcome:    "Done with good results",
		ModifiedAt: closedTime,
	}

	felts := []*felt.Felt{activeFelt, readyFelt, closedFelt}
	g := felt.BuildGraph(felts)

	output := formatSessionOutput(felts, g)

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

	// Check ready section
	if !strings.Contains(output, "## Ready Fibers") {
		t.Error("missing ready fibers section")
	}
	if !strings.Contains(output, "○ ready-task-87654321\n    Ready task") {
		t.Error("missing ready task entry")
	}

	// Check recently touched section
	if !strings.Contains(output, "## Recently Touched") {
		t.Error("missing recently touched section")
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
	g := felt.BuildGraph(felts)

	output := formatSessionOutput(felts, g)

	// Should show empty message
	if !strings.Contains(output, "No active or ready fibers") {
		t.Error("missing empty state message")
	}
}

func TestFormatSessionOutput_BlockedReady(t *testing.T) {
	now := time.Now()

	// Create a fiber that's blocked by an open dependency
	blockerFelt := &felt.Felt{
		ID:        "blocker-task-12345678",
		Title:     "Blocker",
		Status:    felt.StatusOpen,

		CreatedAt: now,
	}

	blockedFelt := &felt.Felt{
		ID:        "blocked-task-87654321",
		Title:     "Blocked task",
		Status:    felt.StatusOpen,

		DependsOn: felt.Dependencies{{ID: "blocker-task-12345678"}},
		CreatedAt: now.Add(time.Minute),
	}

	felts := []*felt.Felt{blockerFelt, blockedFelt}
	g := felt.BuildGraph(felts)

	output := formatSessionOutput(felts, g)

	// Blocker should be ready (no deps)
	if !strings.Contains(output, "blocker-task-12345678") {
		t.Error("blocker task should appear in ready")
	}

	// Blocked task should NOT appear in ready (has open dep)
	// Extract just the Ready section (between "## Ready" and the next "##")
	readyStart := strings.Index(output, "## Ready Fibers")
	if readyStart >= 0 {
		rest := output[readyStart+len("## Ready Fibers"):]
		nextSection := strings.Index(rest, "## ")
		readySection := rest
		if nextSection >= 0 {
			readySection = rest[:nextSection]
		}
		if strings.Contains(readySection, "blocked-task-87654321") {
			t.Error("blocked task should not appear in ready section")
		}
	}
}

func TestFormatSessionOutput_UnblockedByClosedDep(t *testing.T) {
	now := time.Now()
	closedTime := now.Add(-time.Hour)

	// Create a closed dependency - fibers depending on it should be ready
	closedDepFelt := &felt.Felt{
		ID:         "closed-dep-12345678",
		Title:      "Completed prereq",
		Status:     felt.StatusClosed,
		CreatedAt:  now.Add(-2 * time.Hour),
		ClosedAt:   &closedTime,
		ModifiedAt: closedTime,
	}

	// This fiber depends on the closed dep, so it should be ready
	unblockedFelt := &felt.Felt{
		ID:        "unblocked-task-87654321",
		Title:     "Task unblocked by closed dep",
		Status:    felt.StatusOpen,

		DependsOn: felt.Dependencies{{ID: "closed-dep-12345678"}},
		CreatedAt: now.Add(time.Minute),
	}

	felts := []*felt.Felt{closedDepFelt, unblockedFelt}
	g := felt.BuildGraph(felts)

	output := formatSessionOutput(felts, g)

	// The unblocked task should appear in ready section
	if !strings.Contains(output, "## Ready Fibers") {
		t.Error("missing ready fibers section")
	}
	if !strings.Contains(output, "unblocked-task-87654321") {
		t.Error("fiber with closed dependency should appear in ready section")
	}

	// The closed dependency should appear in recently touched
	if !strings.Contains(output, "## Recently Touched") {
		t.Error("missing recently touched section")
	}
	if !strings.Contains(output, "closed-dep-12345678") {
		t.Error("closed fiber should appear in recently touched")
	}
}

func TestFormatSessionOutput_TagLabels(t *testing.T) {
	now := time.Now()

	// Create fibers with different tags
	taskFelt := &felt.Felt{
		ID:        "impl-auth-12345678",
		Title:     "Implement auth",
		Status:    felt.StatusActive,

		CreatedAt: now,
	}

	decisionFelt := &felt.Felt{
		ID:        "design-api-87654321",
		Title:     "Design REST API",
		Status:    felt.StatusOpen,
		Tags:      []string{"decision"},

		CreatedAt: now,
	}

	questionFelt := &felt.Felt{
		ID:        "research-lib-abcdef12",
		Title:     "Which library?",
		Status:    felt.StatusOpen,
		Tags:      []string{"question"},

		CreatedAt: now,
	}

	felts := []*felt.Felt{taskFelt, decisionFelt, questionFelt}
	g := felt.BuildGraph(felts)

	output := formatSessionOutput(felts, g)

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

func TestFormatFiberEntry(t *testing.T) {
	tests := []struct {
		name     string
		icon     string
		felt     *felt.Felt
		expected string
	}{
		{
			name: "no tags - no label",
			icon: "◐",
			felt: &felt.Felt{
				ID:    "impl-auth-12345678",
				Title: "Implement auth",
			},
			expected: "◐ impl-auth-12345678\n    Implement auth\n",
		},
		{
			name: "decision tag - shows label",
			icon: "○",
			felt: &felt.Felt{
				ID:    "design-api-87654321",
				Title: "Design REST API",
				Tags:  []string{"decision"},
			},
			expected: "○ design-api-87654321\n    Design REST API (decision)\n",
		},
		{
			name: "spec tag - shows label",
			icon: "○",
			felt: &felt.Felt{
				ID:    "api-spec-abcdef12",
				Title: "API specification",
				Tags:  []string{"spec"},
			},
			expected: "○ api-spec-abcdef12\n    API specification (spec)\n",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := formatFiberEntry(tt.icon, tt.felt)
			if result != tt.expected {
				t.Errorf("formatFiberEntry() = %q, want %q", result, tt.expected)
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
			Title:      fmt.Sprintf("Closed task %d", i),
			Status:     felt.StatusClosed,
			ClosedAt:   &closedTime,
			CreatedAt:  now.Add(-10 * time.Hour),
			ModifiedAt: now.Add(-time.Duration(i) * time.Hour),
		})
	}

	g := felt.BuildGraph(felts)
	output := formatSessionOutput(felts, g)

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
				Title:    "Done task",
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
				Title:    "Which approach",
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
				Title:    "No reason given",
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
		Title:    "Long reason task",
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
