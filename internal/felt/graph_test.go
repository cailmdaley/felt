package felt

import (
	"strings"
	"testing"
	"time"
)

func makeTestFelt(id, name, status string, deps []string) *Felt {
	inputs := make([]FiberInput, 0, len(deps))
	for i, depID := range deps {
		inputs = append(inputs, FiberInput{
			ID:   "input_" + string(rune('a'+i)),
			From: depID,
		})
	}
	return &Felt{
		ID:        id,
		Name:      name,
		Status:    status,
		Inputs:    inputs,
		CreatedAt: time.Now(),
	}
}

func TestBuildGraph(t *testing.T) {
	felts := []*Felt{
		makeTestFelt("task-a", "Task A", StatusOpen, nil),
		makeTestFelt("task-b", "Task B", StatusOpen, []string{"task-a"}),
		makeTestFelt("task-c", "Task C", StatusOpen, []string{"task-a", "task-b"}),
	}

	g := BuildGraph(felts)

	// Check nodes
	if len(g.Nodes) != 3 {
		t.Errorf("Nodes count = %d, want 3", len(g.Nodes))
	}

	// Check upstream
	if len(g.Upstream["task-a"]) != 0 {
		t.Errorf("A upstream = %v, want empty", g.Upstream["task-a"])
	}
	if len(g.Upstream["task-b"]) != 1 {
		t.Errorf("B upstream = %v, want 1 dep", g.Upstream["task-b"])
	}
	if len(g.Upstream["task-c"]) != 2 {
		t.Errorf("C upstream = %v, want 2 deps", g.Upstream["task-c"])
	}

	// Check downstream (computed inverse)
	if len(g.Downstream["task-a"]) != 2 {
		t.Errorf("A downstream = %v, want 2", g.Downstream["task-a"])
	}
	if len(g.Downstream["task-b"]) != 1 {
		t.Errorf("B downstream = %v, want 1", g.Downstream["task-b"])
	}
	if len(g.Downstream["task-c"]) != 0 {
		t.Errorf("C downstream = %v, want 0", g.Downstream["task-c"])
	}
}

func TestGetUpstream(t *testing.T) {
	// A <- B <- C <- D
	felts := []*Felt{
		makeTestFelt("task-a", "A", StatusOpen, nil),
		makeTestFelt("task-b", "B", StatusOpen, []string{"task-a"}),
		makeTestFelt("task-c", "C", StatusOpen, []string{"task-b"}),
		makeTestFelt("task-d", "D", StatusOpen, []string{"task-c"}),
	}

	g := BuildGraph(felts)

	upstream := g.GetUpstream("task-d")
	if len(upstream) != 3 {
		t.Errorf("D upstream count = %d, want 3", len(upstream))
	}

	upstream = g.GetUpstream("task-b")
	if len(upstream) != 1 {
		t.Errorf("B upstream count = %d, want 1", len(upstream))
	}

	upstream = g.GetUpstream("task-a")
	if len(upstream) != 0 {
		t.Errorf("A upstream count = %d, want 0", len(upstream))
	}
}

func TestGetDownstream(t *testing.T) {
	// A <- B <- C
	//  \_ D
	felts := []*Felt{
		makeTestFelt("task-a", "A", StatusOpen, nil),
		makeTestFelt("task-b", "B", StatusOpen, []string{"task-a"}),
		makeTestFelt("task-c", "C", StatusOpen, []string{"task-b"}),
		makeTestFelt("task-d", "D", StatusOpen, []string{"task-a"}),
	}

	g := BuildGraph(felts)

	downstream := g.GetDownstream("task-a")
	if len(downstream) != 3 {
		t.Errorf("A downstream count = %d, want 3", len(downstream))
	}

	downstream = g.GetDownstream("task-b")
	if len(downstream) != 1 {
		t.Errorf("B downstream count = %d, want 1", len(downstream))
	}

	downstream = g.GetDownstream("task-c")
	if len(downstream) != 0 {
		t.Errorf("C downstream count = %d, want 0", len(downstream))
	}
}

func TestGetUpstreamN(t *testing.T) {
	// A <- B <- C <- D
	felts := []*Felt{
		makeTestFelt("task-a", "A", StatusOpen, nil),
		makeTestFelt("task-b", "B", StatusOpen, []string{"task-a"}),
		makeTestFelt("task-c", "C", StatusOpen, []string{"task-b"}),
		makeTestFelt("task-d", "D", StatusOpen, []string{"task-c"}),
	}

	g := BuildGraph(felts)

	// Depth 1: direct parents only
	upstream := g.GetUpstreamN("task-d", 1)
	if len(upstream) != 1 {
		t.Errorf("D upstream depth=1 count = %d, want 1", len(upstream))
	}
	if len(upstream) > 0 && upstream[0] != "task-c" {
		t.Errorf("D upstream depth=1 = %v, want [task-c]", upstream)
	}

	// Depth 2: parents and grandparents
	upstream = g.GetUpstreamN("task-d", 2)
	if len(upstream) != 2 {
		t.Errorf("D upstream depth=2 count = %d, want 2", len(upstream))
	}

	// Depth 0: unlimited (full transitive closure)
	upstream = g.GetUpstreamN("task-d", 0)
	if len(upstream) != 3 {
		t.Errorf("D upstream depth=0 count = %d, want 3", len(upstream))
	}

	// Depth 1 from B: just A
	upstream = g.GetUpstreamN("task-b", 1)
	if len(upstream) != 1 {
		t.Errorf("B upstream depth=1 count = %d, want 1", len(upstream))
	}

	// Depth 1 from A: nothing
	upstream = g.GetUpstreamN("task-a", 1)
	if len(upstream) != 0 {
		t.Errorf("A upstream depth=1 count = %d, want 0", len(upstream))
	}
}

func TestGetDownstreamN(t *testing.T) {
	// A <- B <- C
	//  \_ D
	felts := []*Felt{
		makeTestFelt("task-a", "A", StatusOpen, nil),
		makeTestFelt("task-b", "B", StatusOpen, []string{"task-a"}),
		makeTestFelt("task-c", "C", StatusOpen, []string{"task-b"}),
		makeTestFelt("task-d", "D", StatusOpen, []string{"task-a"}),
	}

	g := BuildGraph(felts)

	// Depth 1 from A: direct children B and D
	downstream := g.GetDownstreamN("task-a", 1)
	if len(downstream) != 2 {
		t.Errorf("A downstream depth=1 count = %d, want 2", len(downstream))
	}

	// Depth 2 from A: B, D, and C (grandchild via B)
	downstream = g.GetDownstreamN("task-a", 2)
	if len(downstream) != 3 {
		t.Errorf("A downstream depth=2 count = %d, want 3", len(downstream))
	}

	// Depth 0 from A: full transitive closure
	downstream = g.GetDownstreamN("task-a", 0)
	if len(downstream) != 3 {
		t.Errorf("A downstream depth=0 count = %d, want 3", len(downstream))
	}

	// Depth 1 from B: just C
	downstream = g.GetDownstreamN("task-b", 1)
	if len(downstream) != 1 {
		t.Errorf("B downstream depth=1 count = %d, want 1", len(downstream))
	}

	// Depth 1 from C: nothing
	downstream = g.GetDownstreamN("task-c", 1)
	if len(downstream) != 0 {
		t.Errorf("C downstream depth=1 count = %d, want 0", len(downstream))
	}
}

func TestReady(t *testing.T) {
	// A (closed) <- B (open) <- C (open)
	felts := []*Felt{
		makeTestFelt("task-a", "A", StatusClosed, nil),
		makeTestFelt("task-b", "B", StatusOpen, []string{"task-a"}),
		makeTestFelt("task-c", "C", StatusOpen, []string{"task-b"}),
	}

	g := BuildGraph(felts)
	ready := g.Ready()

	if len(ready) != 1 {
		t.Errorf("Ready count = %d, want 1", len(ready))
	}
	if ready[0].ID != "task-b" {
		t.Errorf("Ready[0].ID = %s, want task-b", ready[0].ID)
	}
}

func TestReadyNoDeps(t *testing.T) {
	// Both A and B are open with no deps - both ready
	felts := []*Felt{
		makeTestFelt("task-a", "A", StatusOpen, nil),
		makeTestFelt("task-b", "B", StatusOpen, nil),
	}

	g := BuildGraph(felts)
	ready := g.Ready()

	if len(ready) != 2 {
		t.Errorf("Ready count = %d, want 2", len(ready))
	}
}

func TestReadyExcludesActive(t *testing.T) {
	// A (open, no deps) and B (active, no deps)
	// Only A should be in ready - active felts are already being worked on
	felts := []*Felt{
		makeTestFelt("task-a", "A", StatusOpen, nil),
		makeTestFelt("task-b", "B", StatusActive, nil),
	}

	g := BuildGraph(felts)
	ready := g.Ready()

	if len(ready) != 1 {
		t.Errorf("Ready count = %d, want 1 (active should be excluded)", len(ready))
	}
	if len(ready) > 0 && ready[0].ID != "task-a" {
		t.Errorf("Ready[0].ID = %s, want task-a (the open one)", ready[0].ID)
	}
}

func TestDetectCycle(t *testing.T) {
	// A <- B (existing)
	felts := []*Felt{
		makeTestFelt("task-a", "A", StatusOpen, nil),
		makeTestFelt("task-b", "B", StatusOpen, []string{"task-a"}),
	}

	g := BuildGraph(felts)

	// Adding A -> B would create cycle
	if !g.DetectCycle("task-a", "task-b") {
		t.Error("DetectCycle should detect A->B cycle")
	}

	// Self-reference
	if !g.DetectCycle("task-a", "task-a") {
		t.Error("DetectCycle should detect self-reference")
	}

	// No cycle: B -> C (new)
	if g.DetectCycle("task-b", "task-c") {
		t.Error("DetectCycle should not flag B->C")
	}
}

func TestValidateDependencies(t *testing.T) {
	felts := []*Felt{
		makeTestFelt("task-a", "A", StatusOpen, []string{"nonexistent"}),
		makeTestFelt("task-b", "B", StatusOpen, []string{"task-a"}),
	}

	g := BuildGraph(felts)
	errors := g.ValidateDependencies()

	if len(errors) != 1 {
		t.Errorf("Validation errors = %d, want 1", len(errors))
	}
	if !strings.Contains(errors[0], "nonexistent") {
		t.Errorf("Error should mention nonexistent: %s", errors[0])
	}
}

func TestFindPath(t *testing.T) {
	// A <- B <- C <- D
	felts := []*Felt{
		makeTestFelt("task-a", "A", StatusOpen, nil),
		makeTestFelt("task-b", "B", StatusOpen, []string{"task-a"}),
		makeTestFelt("task-c", "C", StatusOpen, []string{"task-b"}),
		makeTestFelt("task-d", "D", StatusOpen, []string{"task-c"}),
	}

	g := BuildGraph(felts)

	path := g.FindPath("task-d", "task-a")
	if path == nil {
		t.Fatal("FindPath should find path from D to A")
	}
	if len(path) != 4 {
		t.Errorf("Path length = %d, want 4", len(path))
	}

	// No path from A to D (wrong direction)
	path = g.FindPath("task-a", "task-d")
	if path != nil {
		t.Error("FindPath should not find path from A to D")
	}

	// Same node
	path = g.FindPath("task-a", "task-a")
	if len(path) != 1 {
		t.Errorf("Same node path length = %d, want 1", len(path))
	}
}

func TestToMermaid(t *testing.T) {
	felts := []*Felt{
		makeTestFelt("task-a", "A", StatusOpen, nil),
		makeTestFelt("task-b", "B", StatusActive, []string{"task-a"}),
		makeTestFelt("task-c", "C", StatusClosed, []string{"task-b"}),
	}

	g := BuildGraph(felts)
	mermaid := g.ToMermaid()

	if !strings.HasPrefix(mermaid, "graph TD") {
		t.Error("Mermaid should start with graph TD")
	}
	if !strings.Contains(mermaid, "task_a") {
		t.Error("Mermaid should contain node a")
	}
	if !strings.Contains(mermaid, "-->") {
		t.Error("Mermaid should contain edges")
	}
	if !strings.Contains(mermaid, "classDef") {
		t.Error("Mermaid should contain class definitions")
	}
}

func TestToMermaidEscaping(t *testing.T) {
	felts := []*Felt{
		makeTestFelt("task-a", `Title with <brackets> & "quotes"`, StatusOpen, nil),
	}

	g := BuildGraph(felts)
	mermaid := g.ToMermaid()

	// Should escape angle brackets
	if strings.Contains(mermaid, "<brackets>") {
		t.Error("Mermaid should escape < and >")
	}
	if !strings.Contains(mermaid, "&lt;brackets&gt;") {
		t.Error("Mermaid should contain escaped angle brackets")
	}
	// Should escape ampersand
	if strings.Contains(mermaid, " & ") {
		t.Error("Mermaid should escape &")
	}
	if !strings.Contains(mermaid, "&amp;") {
		t.Error("Mermaid should contain escaped ampersand")
	}
	// Should escape quotes
	if !strings.Contains(mermaid, "&quot;quotes&quot;") {
		t.Error("Mermaid should contain escaped quotes")
	}
}

func TestToDot(t *testing.T) {
	felts := []*Felt{
		makeTestFelt("task-a", "A", StatusOpen, nil),
		makeTestFelt("task-b", "B", StatusOpen, []string{"task-a"}),
	}

	g := BuildGraph(felts)
	dot := g.ToDot()

	if !strings.HasPrefix(dot, "digraph felt") {
		t.Error("Dot should start with digraph felt")
	}
	if !strings.Contains(dot, "->") {
		t.Error("Dot should contain edges")
	}
}

func TestFindCycles(t *testing.T) {
	// No cycle
	felts := []*Felt{
		makeTestFelt("task-a", "A", StatusOpen, nil),
		makeTestFelt("task-b", "B", StatusOpen, []string{"task-a"}),
	}
	g := BuildGraph(felts)
	cycles := g.FindCycles()
	if len(cycles) != 0 {
		t.Errorf("FindCycles found %d cycles, want 0", len(cycles))
	}

	// Create a cycle: A -> B -> A (manually set deps to bypass validation)
	felts = []*Felt{
		makeTestFelt("task-a", "A", StatusOpen, []string{"task-b"}),
		makeTestFelt("task-b", "B", StatusOpen, []string{"task-a"}),
	}
	g = BuildGraph(felts)
	cycles = g.FindCycles()
	if len(cycles) == 0 {
		t.Error("FindCycles should detect A->B->A cycle")
	}

	// Self-cycle
	felts = []*Felt{
		makeTestFelt("task-a", "A", StatusOpen, []string{"task-a"}),
	}
	g = BuildGraph(felts)
	cycles = g.FindCycles()
	if len(cycles) == 0 {
		t.Error("FindCycles should detect self-cycle")
	}
}

func TestToText(t *testing.T) {
	// Simple chain: A <- B <- C
	felts := []*Felt{
		makeTestFelt("task-a", "A", StatusClosed, nil),
		makeTestFelt("task-b", "B", StatusActive, []string{"task-a"}),
		makeTestFelt("task-c", "C", StatusOpen, []string{"task-b"}),
	}

	g := BuildGraph(felts)
	text := g.ToText()

	// Should contain all nodes
	if !strings.Contains(text, "A") {
		t.Error("ToText should contain node A")
	}
	if !strings.Contains(text, "B") {
		t.Error("ToText should contain node B")
	}
	if !strings.Contains(text, "C") {
		t.Error("ToText should contain node C")
	}

	// Should show status indicators
	if !strings.Contains(text, "●") {
		t.Error("ToText should show closed status indicator")
	}
	if !strings.Contains(text, "◐") {
		t.Error("ToText should show active status indicator")
	}
	if !strings.Contains(text, "○") {
		t.Error("ToText should show open status indicator")
	}

	// Should show tree structure
	if !strings.Contains(text, "└──") || !strings.Contains(text, "├──") {
		// At least one of these should appear for hierarchy
		if !strings.Contains(text, "└──") {
			t.Log("Note: no └── found, checking for basic structure")
		}
	}
}

func TestToTextMultipleRoots(t *testing.T) {
	// Two separate trees
	felts := []*Felt{
		makeTestFelt("task-a", "A", StatusOpen, nil),
		makeTestFelt("task-b", "B", StatusOpen, []string{"task-a"}),
		makeTestFelt("task-x", "X", StatusOpen, nil),
		makeTestFelt("task-y", "Y", StatusOpen, []string{"task-x"}),
	}

	g := BuildGraph(felts)
	text := g.ToText()

	// Should contain all nodes
	if !strings.Contains(text, "A") || !strings.Contains(text, "B") {
		t.Error("ToText should contain A-B tree")
	}
	if !strings.Contains(text, "X") || !strings.Contains(text, "Y") {
		t.Error("ToText should contain X-Y tree")
	}
}

func TestBuildGraphWithLabels(t *testing.T) {
	felts := []*Felt{
		{
			ID: "task-a", Name: "A", Status: StatusOpen, CreatedAt: time.Now(),
		},
		{
			ID: "task-b", Name: "B", Status: StatusOpen,
			Inputs: []FiberInput{{ID: "needs_data", From: "task-a"}},
			CreatedAt: time.Now(),
		},
	}

	g := BuildGraph(felts)

	// Upstream of B should have label
	if len(g.Upstream["task-b"]) != 1 {
		t.Fatalf("B upstream count = %d, want 1", len(g.Upstream["task-b"]))
	}
	if g.Upstream["task-b"][0].Label != "needs_data" {
		t.Errorf("B upstream label = %q, want %q", g.Upstream["task-b"][0].Label, "needs_data")
	}

	// Downstream of A should have label
	if len(g.Downstream["task-a"]) != 1 {
		t.Fatalf("A downstream count = %d, want 1", len(g.Downstream["task-a"]))
	}
	if g.Downstream["task-a"][0].Label != "needs_data" {
		t.Errorf("A downstream label = %q, want %q", g.Downstream["task-a"][0].Label, "needs_data")
	}
}

func TestToMermaidWithLabels(t *testing.T) {
	felts := []*Felt{
		{
			ID: "task-a", Name: "A", Status: StatusOpen, CreatedAt: time.Now(),
		},
		{
			ID: "task-b", Name: "B", Status: StatusOpen,
			Inputs: []FiberInput{{ID: "input_b", From: "task-a.blocks"}},
			CreatedAt: time.Now(),
		},
	}

	g := BuildGraph(felts)
	mermaid := g.ToMermaid()

	if !strings.Contains(mermaid, "-->|blocks|") {
		t.Errorf("Mermaid should contain labeled edge, got:\n%s", mermaid)
	}
}

func TestToDotWithLabels(t *testing.T) {
	felts := []*Felt{
		{
			ID: "task-a", Name: "A", Status: StatusOpen, CreatedAt: time.Now(),
		},
		{
			ID: "task-b", Name: "B", Status: StatusOpen,
			Inputs: []FiberInput{{ID: "input_b", From: "task-a.provides input"}},
			CreatedAt: time.Now(),
		},
	}

	g := BuildGraph(felts)
	dot := g.ToDot()

	if !strings.Contains(dot, `[label="provides input"]`) {
		t.Errorf("DOT should contain labeled edge, got:\n%s", dot)
	}
}

func TestToTextWithLabels(t *testing.T) {
	felts := []*Felt{
		{
			ID: "task-a", Name: "A", Status: StatusOpen, CreatedAt: time.Now(),
		},
		{
			ID: "task-b", Name: "B", Status: StatusOpen,
			Inputs: []FiberInput{{ID: "input_b", From: "task-a.reason"}},
			CreatedAt: time.Now(),
		},
	}

	g := BuildGraph(felts)
	text := g.ToText()

	if !strings.Contains(text, "[reason]") {
		t.Errorf("Text tree should contain label, got:\n%s", text)
	}
}
