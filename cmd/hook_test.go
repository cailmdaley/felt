package cmd

import (
	"fmt"
	"os"
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

	// Check context recovery hint
	if !strings.Contains(output, "Context Recovery") {
		t.Error("missing context recovery hint")
	}

	// Check no repository message
	if !strings.Contains(output, "No felt repository") {
		t.Error("missing no repository message")
	}

	// Check core rules
	if !strings.Contains(output, "## Core Rules") {
		t.Error("missing core rules section")
	}
}

func TestFormatSessionOutput(t *testing.T) {
	now := time.Now()

	// Create test felts
	activeFelt := &felt.Felt{
		ID:        "active-task-12345678",
		Title:     "Active task",
		Status:    felt.StatusActive,
		Kind:      felt.DefaultKind,
		Priority:  2,
		CreatedAt: now,
	}

	readyFelt := &felt.Felt{
		ID:        "ready-task-87654321",
		Title:     "Ready task",
		Status:    felt.StatusOpen,
		Kind:      felt.DefaultKind,
		Priority:  2,
		CreatedAt: now,
	}

	closedFelt := &felt.Felt{
		ID:        "closed-task-abcdef12",
		Title:     "Closed task",
		Status:    felt.StatusClosed,
		Kind:      felt.DefaultKind,
		Priority:  2,
		CreatedAt: now,
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
	if !strings.Contains(output, "## Ready Fibers (unblocked)") {
		t.Error("missing ready fibers section")
	}
	if !strings.Contains(output, "○ ready-task-87654321\n    Ready task") {
		t.Error("missing ready task entry")
	}

	// Closed task should not appear
	if strings.Contains(output, "closed-task-abcdef12") {
		t.Error("closed task should not appear in output")
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

func TestFormatSessionOutput_PrioritySorting(t *testing.T) {
	now := time.Now()

	// Create active fibers with different priorities
	// Lower priority number = higher priority
	lowPriorityActive := &felt.Felt{
		ID:        "low-priority-12345678",
		Title:     "Low priority active",
		Status:    felt.StatusActive,
		Kind:      felt.DefaultKind,
		Priority:  3,
		CreatedAt: now,
	}

	highPriorityActive := &felt.Felt{
		ID:        "high-priority-87654321",
		Title:     "High priority active",
		Status:    felt.StatusActive,
		Kind:      felt.DefaultKind,
		Priority:  1,
		CreatedAt: now.Add(time.Minute), // Created later but higher priority
	}

	felts := []*felt.Felt{lowPriorityActive, highPriorityActive}
	g := felt.BuildGraph(felts)

	output := formatSessionOutput(felts, g)

	// High priority should appear before low priority
	highIdx := strings.Index(output, "high-priority-87654321")
	lowIdx := strings.Index(output, "low-priority-12345678")

	if highIdx < 0 || lowIdx < 0 {
		t.Error("both active fibers should appear in output")
	}

	if highIdx > lowIdx {
		t.Error("high priority fiber should appear before low priority fiber")
	}
}

func TestFormatSessionOutput_BlockedReady(t *testing.T) {
	now := time.Now()

	// Create a fiber that's blocked by an open dependency
	blockerFelt := &felt.Felt{
		ID:        "blocker-task-12345678",
		Title:     "Blocker",
		Status:    felt.StatusOpen,
		Kind:      felt.DefaultKind,
		Priority:  2,
		CreatedAt: now,
	}

	blockedFelt := &felt.Felt{
		ID:        "blocked-task-87654321",
		Title:     "Blocked task",
		Status:    felt.StatusOpen,
		Kind:      felt.DefaultKind,
		Priority:  2,
		DependsOn: []string{"blocker-task-12345678"},
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
	// Count occurrences - blocked should not be in ready section
	readySection := strings.Split(output, "## Core Rules")[0]
	if strings.Contains(readySection, "blocked-task-87654321") {
		t.Error("blocked task should not appear in ready section")
	}
}

func TestFormatSessionOutput_UnblockedByClosedDep(t *testing.T) {
	now := time.Now()

	// Create a closed dependency - fibers depending on it should be ready
	closedDepFelt := &felt.Felt{
		ID:        "closed-dep-12345678",
		Title:     "Completed prereq",
		Status:    felt.StatusClosed,
		Kind:      felt.DefaultKind,
		Priority:  2,
		CreatedAt: now,
	}

	// This fiber depends on the closed dep, so it should be ready
	unblockedFelt := &felt.Felt{
		ID:        "unblocked-task-87654321",
		Title:     "Task unblocked by closed dep",
		Status:    felt.StatusOpen,
		Kind:      felt.DefaultKind,
		Priority:  2,
		DependsOn: []string{"closed-dep-12345678"},
		CreatedAt: now.Add(time.Minute),
	}

	felts := []*felt.Felt{closedDepFelt, unblockedFelt}
	g := felt.BuildGraph(felts)

	output := formatSessionOutput(felts, g)

	// The unblocked task should appear in ready section
	if !strings.Contains(output, "## Ready Fibers (unblocked)") {
		t.Error("missing ready fibers section")
	}
	if !strings.Contains(output, "unblocked-task-87654321") {
		t.Error("fiber with closed dependency should appear in ready section")
	}

	// The closed dependency should NOT appear anywhere in the output
	if strings.Contains(output, "closed-dep-12345678") {
		t.Error("closed fiber should not appear in hook session output")
	}
}

func TestFormatSessionOutput_KindLabels(t *testing.T) {
	now := time.Now()

	// Create fibers with different kinds
	taskFelt := &felt.Felt{
		ID:        "impl-auth-12345678",
		Title:     "Implement auth",
		Status:    felt.StatusActive,
		Kind:      felt.DefaultKind, // "task" - should NOT show label
		Priority:  2,
		CreatedAt: now,
	}

	decisionFelt := &felt.Felt{
		ID:        "design-api-87654321",
		Title:     "Design REST API",
		Status:    felt.StatusOpen,
		Kind:      "decision", // non-default - should show [decision]
		Priority:  2,
		CreatedAt: now,
	}

	questionFelt := &felt.Felt{
		ID:        "research-lib-abcdef12",
		Title:     "Which library?",
		Status:    felt.StatusOpen,
		Kind:      "question", // non-default - should show [question]
		Priority:  2,
		CreatedAt: now,
	}

	felts := []*felt.Felt{taskFelt, decisionFelt, questionFelt}
	g := felt.BuildGraph(felts)

	output := formatSessionOutput(felts, g)

	// Task (default kind) should NOT have a kind label
	if strings.Contains(output, "[task]") {
		t.Error("default 'task' kind should not show label")
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
			name: "default task kind - no label",
			icon: "◐",
			felt: &felt.Felt{
				ID:    "impl-auth-12345678",
				Title: "Implement auth",
				Kind:  felt.DefaultKind,
			},
			expected: "◐ impl-auth-12345678\n    Implement auth\n",
		},
		{
			name: "decision kind - shows label",
			icon: "○",
			felt: &felt.Felt{
				ID:    "design-api-87654321",
				Title: "Design REST API",
				Kind:  "decision",
			},
			expected: "○ design-api-87654321\n    Design REST API (decision)\n",
		},
		{
			name: "spec kind - shows label",
			icon: "○",
			felt: &felt.Felt{
				ID:    "api-spec-abcdef12",
				Title: "API specification",
				Kind:  "spec",
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

func TestFormatPrimeOutput(t *testing.T) {
	now := time.Now()

	activeFelt := &felt.Felt{
		ID:        "active-task-12345678",
		Title:     "Active task",
		Status:    felt.StatusActive,
		Kind:      felt.DefaultKind,
		Priority:  2,
		Body:      "This is the body of the active task.",
		CreatedAt: now,
	}

	readyFelt := &felt.Felt{
		ID:        "ready-task-87654321",
		Title:     "Ready task",
		Status:    felt.StatusOpen,
		Kind:      "decision",
		Priority:  2,
		Body:      "Decision body here.",
		CreatedAt: now,
	}

	felts := []*felt.Felt{activeFelt, readyFelt}
	g := felt.BuildGraph(felts)

	output := formatPrimeOutput(felts, g)

	// Check header
	if !strings.Contains(output, "# Felt Context Recovery") {
		t.Error("missing header")
	}

	// Check active section with details
	if !strings.Contains(output, "## Active Fibers") {
		t.Error("missing active fibers section")
	}
	if !strings.Contains(output, "### ◐ Active task") {
		t.Error("missing active task header")
	}
	if !strings.Contains(output, "ID: `active-task-12345678`") {
		t.Error("missing active task ID")
	}
	if !strings.Contains(output, "This is the body") {
		t.Error("missing active task body")
	}

	// Check ready section with details
	if !strings.Contains(output, "## Ready Fibers") {
		t.Error("missing ready fibers section")
	}
	if !strings.Contains(output, "### ○ Ready task [decision]") {
		t.Error("missing ready task header with kind")
	}
	if !strings.Contains(output, "Decision body here") {
		t.Error("missing ready task body")
	}
}

func TestFormatPrimeOutput_Empty(t *testing.T) {
	felts := []*felt.Felt{}
	g := felt.BuildGraph(felts)

	output := formatPrimeOutput(felts, g)

	if !strings.Contains(output, "No active or ready fibers") {
		t.Error("missing empty state message")
	}
}

func TestFormatPrimeOutput_TruncatesLongBody(t *testing.T) {
	now := time.Now()

	// Create a fiber with a very long body
	longBody := strings.Repeat("a", 600)
	activeFelt := &felt.Felt{
		ID:        "long-body-12345678",
		Title:     "Long body task",
		Status:    felt.StatusActive,
		Kind:      felt.DefaultKind,
		Priority:  2,
		Body:      longBody,
		CreatedAt: now,
	}

	felts := []*felt.Felt{activeFelt}
	g := felt.BuildGraph(felts)

	output := formatPrimeOutput(felts, g)

	// Should be truncated with ...
	if !strings.Contains(output, "...") {
		t.Error("long body should be truncated with ...")
	}
	// Should not contain the full 600 chars
	if strings.Contains(output, longBody) {
		t.Error("should not contain full long body")
	}
}

func TestFormatFiberDetail(t *testing.T) {
	f := &felt.Felt{
		ID:        "test-task-12345678",
		Title:     "Test task",
		Status:    felt.StatusActive,
		Kind:      "spec",
		DependsOn: []string{"dep-1", "dep-2"},
		Body:      "Task body content",
	}

	result := formatFiberDetail(f)

	// Check header with icon and kind
	if !strings.Contains(result, "### ◐ Test task [spec]") {
		t.Errorf("missing header with icon and kind, got: %s", result)
	}

	// Check ID
	if !strings.Contains(result, "ID: `test-task-12345678`") {
		t.Error("missing ID")
	}

	// Check dependencies
	if !strings.Contains(result, "Depends on: dep-1, dep-2") {
		t.Error("missing dependencies")
	}

	// Check body
	if !strings.Contains(result, "Task body content") {
		t.Error("missing body")
	}
}

func TestFormatPrimeOutput_RecentlyClosed(t *testing.T) {
	now := time.Now()
	closedTime := now.Add(-time.Hour)

	closedFelt := &felt.Felt{
		ID:          "closed-task-12345678",
		Title:       "Completed work",
		Status:      felt.StatusClosed,
		Kind:        felt.DefaultKind,
		Priority:    2,
		ClosedAt:    &closedTime,
		CloseReason: "Task completed successfully with good results",
		CreatedAt:   now.Add(-2 * time.Hour),
	}

	felts := []*felt.Felt{closedFelt}
	g := felt.BuildGraph(felts)

	output := formatPrimeOutput(felts, g)

	// Check recently closed section exists
	if !strings.Contains(output, "## Recently Closed") {
		t.Error("missing recently closed section")
	}

	// Check closed fiber appears with closed icon
	if !strings.Contains(output, "### ● Completed work") {
		t.Errorf("missing closed task header, got: %s", output)
	}

	// Check close reason is shown
	if !strings.Contains(output, "Closed: Task completed successfully") {
		t.Error("missing close reason")
	}
}

func TestFormatPrimeOutput_LimitsRecentlyClosed(t *testing.T) {
	now := time.Now()

	// Create 7 closed fibers
	var felts []*felt.Felt
	for i := 0; i < 7; i++ {
		closedTime := now.Add(-time.Duration(i) * time.Hour)
		felts = append(felts, &felt.Felt{
			ID:        fmt.Sprintf("closed-%d-12345678", i),
			Title:     fmt.Sprintf("Closed task %d", i),
			Status:    felt.StatusClosed,
			Kind:      felt.DefaultKind,
			ClosedAt:  &closedTime,
			CreatedAt: now.Add(-10 * time.Hour),
		})
	}

	g := felt.BuildGraph(felts)
	output := formatPrimeOutput(felts, g)

	// Should only show 5 most recent
	if strings.Contains(output, "closed-5-12345678") {
		t.Error("should not show 6th closed fiber")
	}
	if strings.Contains(output, "closed-6-12345678") {
		t.Error("should not show 7th closed fiber")
	}

	// Should show the 5 most recent
	if !strings.Contains(output, "closed-0-12345678") {
		t.Error("should show most recent closed fiber")
	}
	if !strings.Contains(output, "closed-4-12345678") {
		t.Error("should show 5th most recent closed fiber")
	}
}

func TestFormatClosedFiberSummary(t *testing.T) {
	now := time.Now()

	tests := []struct {
		name     string
		felt     *felt.Felt
		wantIcon string
		wantKind bool
	}{
		{
			name: "basic closed with reason",
			felt: &felt.Felt{
				ID:          "done-task-12345678",
				Title:       "Done task",
				Kind:        felt.DefaultKind,
				CloseReason: "Completed",
				ClosedAt:    &now,
			},
			wantIcon: "●",
			wantKind: false,
		},
		{
			name: "closed decision with kind label",
			felt: &felt.Felt{
				ID:          "decided-12345678",
				Title:       "Which approach",
				Kind:        "decision",
				CloseReason: "Chose option A because of performance",
				ClosedAt:    &now,
			},
			wantIcon: "●",
			wantKind: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := formatClosedFiberSummary(tt.felt)

			if !strings.Contains(result, tt.wantIcon) {
				t.Errorf("missing closed icon, got: %s", result)
			}

			if tt.wantKind && !strings.Contains(result, "[decision]") {
				t.Errorf("missing kind label, got: %s", result)
			}

			if !tt.wantKind && strings.Contains(result, "[task]") {
				t.Error("default kind should not show label")
			}

			if tt.felt.CloseReason != "" && !strings.Contains(result, "Closed:") {
				t.Error("missing close reason prefix")
			}
		})
	}
}

func TestRunHookSync(t *testing.T) {
	// Create a temp directory for testing
	tmpDir := t.TempDir()

	// Change to temp directory for the test
	oldWd, _ := os.Getwd()
	defer os.Chdir(oldWd)
	os.Chdir(tmpDir)

	// Test 1: Create new todos
	input := `{"tool_name":"TodoWrite","tool_input":{"todos":[{"content":"Task one","status":"pending","activeForm":"Working on task one"},{"content":"Task two","status":"in_progress","activeForm":"Doing task two"}]}}`

	err := runHookSync(strings.NewReader(input))
	if err != nil {
		t.Fatalf("runHookSync failed: %v", err)
	}

	// Verify .felt directory was created
	storage := felt.NewStorage(tmpDir)
	if !storage.Exists() {
		t.Error(".felt directory should exist")
	}

	// Verify fibers were created
	felts, err := storage.List()
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(felts) != 2 {
		t.Errorf("expected 2 fibers, got %d", len(felts))
	}

	// Check statuses and kinds
	for _, f := range felts {
		if f.Kind != todoKind {
			t.Errorf("expected kind %q, got %q", todoKind, f.Kind)
		}
		if f.Title == "Task one" && f.Status != felt.StatusOpen {
			t.Errorf("Task one should be open, got %s", f.Status)
		}
		if f.Title == "Task two" && f.Status != felt.StatusActive {
			t.Errorf("Task two should be active, got %s", f.Status)
		}
	}

	// Test 2: Complete one todo, abandon the other
	input2 := `{"tool_name":"TodoWrite","tool_input":{"todos":[{"content":"Task two","status":"completed","activeForm":"Doing task two"}]}}`

	err = runHookSync(strings.NewReader(input2))
	if err != nil {
		t.Fatalf("runHookSync (round 2) failed: %v", err)
	}

	// Reload fibers
	felts, err = storage.List()
	if err != nil {
		t.Fatalf("List (round 2) failed: %v", err)
	}

	// Both should be closed now
	closedCount := 0
	for _, f := range felts {
		if f.IsClosed() {
			closedCount++
			// Check close reasons
			if f.Title == "Task one" && f.CloseReason != "Abandoned from TodoWrite" {
				t.Errorf("Task one should be abandoned, got reason: %s", f.CloseReason)
			}
			if f.Title == "Task two" && f.CloseReason != "Completed via TodoWrite" {
				t.Errorf("Task two should be completed, got reason: %s", f.CloseReason)
			}
		}
	}
	if closedCount != 2 {
		t.Errorf("expected 2 closed fibers, got %d", closedCount)
	}

	// Verify mapping is empty after all todos processed
	mapping, err := loadTodoMapping(tmpDir)
	if err != nil {
		t.Fatalf("loadTodoMapping failed: %v", err)
	}
	if len(mapping) != 0 {
		t.Errorf("mapping should be empty, got %d entries", len(mapping))
	}
}

func TestRunHookSync_IgnoresNonTodoWrite(t *testing.T) {
	tmpDir := t.TempDir()
	oldWd, _ := os.Getwd()
	defer os.Chdir(oldWd)
	os.Chdir(tmpDir)

	// Non-TodoWrite input should be silently ignored
	input := `{"tool_name":"Bash","tool_input":{"command":"ls"}}`

	err := runHookSync(strings.NewReader(input))
	if err != nil {
		t.Fatalf("runHookSync should not error on non-TodoWrite: %v", err)
	}

	// No .felt directory should be created
	storage := felt.NewStorage(tmpDir)
	if storage.Exists() {
		t.Error(".felt directory should not be created for non-TodoWrite")
	}
}

func TestRunHookSync_EmptyInput(t *testing.T) {
	err := runHookSync(strings.NewReader(""))
	if err != nil {
		t.Errorf("empty input should not error: %v", err)
	}
}
