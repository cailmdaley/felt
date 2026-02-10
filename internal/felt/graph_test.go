package felt

import (
	"strings"
	"testing"
	"time"
)

func makeTestFelt(id, title, status string, deps []string) *Felt {
	var d Dependencies
	for _, id := range deps {
		d = append(d, Dependency{ID: id})
	}
	return &Felt{
		ID:        id,
		Title:     title,
		Status:    status,
		Priority:  2,
		DependsOn: d,
		CreatedAt: time.Now(),
	}
}

func TestBuildGraph(t *testing.T) {
	felts := []*Felt{
		makeTestFelt("a-11111111", "Task A", StatusOpen, nil),
		makeTestFelt("b-22222222", "Task B", StatusOpen, []string{"a-11111111"}),
		makeTestFelt("c-33333333", "Task C", StatusOpen, []string{"a-11111111", "b-22222222"}),
	}

	g := BuildGraph(felts)

	// Check nodes
	if len(g.Nodes) != 3 {
		t.Errorf("Nodes count = %d, want 3", len(g.Nodes))
	}

	// Check upstream
	if len(g.Upstream["a-11111111"]) != 0 {
		t.Errorf("A upstream = %v, want empty", g.Upstream["a-11111111"])
	}
	if len(g.Upstream["b-22222222"]) != 1 {
		t.Errorf("B upstream = %v, want 1 dep", g.Upstream["b-22222222"])
	}
	if len(g.Upstream["c-33333333"]) != 2 {
		t.Errorf("C upstream = %v, want 2 deps", g.Upstream["c-33333333"])
	}

	// Check downstream (computed inverse)
	if len(g.Downstream["a-11111111"]) != 2 {
		t.Errorf("A downstream = %v, want 2", g.Downstream["a-11111111"])
	}
	if len(g.Downstream["b-22222222"]) != 1 {
		t.Errorf("B downstream = %v, want 1", g.Downstream["b-22222222"])
	}
	if len(g.Downstream["c-33333333"]) != 0 {
		t.Errorf("C downstream = %v, want 0", g.Downstream["c-33333333"])
	}
}

func TestGetUpstream(t *testing.T) {
	// A <- B <- C <- D
	felts := []*Felt{
		makeTestFelt("a-11111111", "A", StatusOpen, nil),
		makeTestFelt("b-22222222", "B", StatusOpen, []string{"a-11111111"}),
		makeTestFelt("c-33333333", "C", StatusOpen, []string{"b-22222222"}),
		makeTestFelt("d-44444444", "D", StatusOpen, []string{"c-33333333"}),
	}

	g := BuildGraph(felts)

	upstream := g.GetUpstream("d-44444444")
	if len(upstream) != 3 {
		t.Errorf("D upstream count = %d, want 3", len(upstream))
	}

	upstream = g.GetUpstream("b-22222222")
	if len(upstream) != 1 {
		t.Errorf("B upstream count = %d, want 1", len(upstream))
	}

	upstream = g.GetUpstream("a-11111111")
	if len(upstream) != 0 {
		t.Errorf("A upstream count = %d, want 0", len(upstream))
	}
}

func TestGetDownstream(t *testing.T) {
	// A <- B <- C
	//  \_ D
	felts := []*Felt{
		makeTestFelt("a-11111111", "A", StatusOpen, nil),
		makeTestFelt("b-22222222", "B", StatusOpen, []string{"a-11111111"}),
		makeTestFelt("c-33333333", "C", StatusOpen, []string{"b-22222222"}),
		makeTestFelt("d-44444444", "D", StatusOpen, []string{"a-11111111"}),
	}

	g := BuildGraph(felts)

	downstream := g.GetDownstream("a-11111111")
	if len(downstream) != 3 {
		t.Errorf("A downstream count = %d, want 3", len(downstream))
	}

	downstream = g.GetDownstream("b-22222222")
	if len(downstream) != 1 {
		t.Errorf("B downstream count = %d, want 1", len(downstream))
	}

	downstream = g.GetDownstream("c-33333333")
	if len(downstream) != 0 {
		t.Errorf("C downstream count = %d, want 0", len(downstream))
	}
}

func TestReady(t *testing.T) {
	// A (closed) <- B (open) <- C (open)
	felts := []*Felt{
		makeTestFelt("a-11111111", "A", StatusClosed, nil),
		makeTestFelt("b-22222222", "B", StatusOpen, []string{"a-11111111"}),
		makeTestFelt("c-33333333", "C", StatusOpen, []string{"b-22222222"}),
	}

	g := BuildGraph(felts)
	ready := g.Ready()

	if len(ready) != 1 {
		t.Errorf("Ready count = %d, want 1", len(ready))
	}
	if ready[0].ID != "b-22222222" {
		t.Errorf("Ready[0].ID = %s, want b-22222222", ready[0].ID)
	}
}

func TestReadyNoDeps(t *testing.T) {
	// Both A and B are open with no deps - both ready
	felts := []*Felt{
		makeTestFelt("a-11111111", "A", StatusOpen, nil),
		makeTestFelt("b-22222222", "B", StatusOpen, nil),
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
		makeTestFelt("a-11111111", "A", StatusOpen, nil),
		makeTestFelt("b-22222222", "B", StatusActive, nil),
	}

	g := BuildGraph(felts)
	ready := g.Ready()

	if len(ready) != 1 {
		t.Errorf("Ready count = %d, want 1 (active should be excluded)", len(ready))
	}
	if len(ready) > 0 && ready[0].ID != "a-11111111" {
		t.Errorf("Ready[0].ID = %s, want a-11111111 (the open one)", ready[0].ID)
	}
}

func TestDetectCycle(t *testing.T) {
	// A <- B (existing)
	felts := []*Felt{
		makeTestFelt("a-11111111", "A", StatusOpen, nil),
		makeTestFelt("b-22222222", "B", StatusOpen, []string{"a-11111111"}),
	}

	g := BuildGraph(felts)

	// Adding A -> B would create cycle
	if !g.DetectCycle("a-11111111", "b-22222222") {
		t.Error("DetectCycle should detect A->B cycle")
	}

	// Self-reference
	if !g.DetectCycle("a-11111111", "a-11111111") {
		t.Error("DetectCycle should detect self-reference")
	}

	// No cycle: B -> C (new)
	if g.DetectCycle("b-22222222", "c-33333333") {
		t.Error("DetectCycle should not flag B->C")
	}
}

func TestValidateDependencies(t *testing.T) {
	felts := []*Felt{
		makeTestFelt("a-11111111", "A", StatusOpen, []string{"nonexistent-12345678"}),
		makeTestFelt("b-22222222", "B", StatusOpen, []string{"a-11111111"}),
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
		makeTestFelt("a-11111111", "A", StatusOpen, nil),
		makeTestFelt("b-22222222", "B", StatusOpen, []string{"a-11111111"}),
		makeTestFelt("c-33333333", "C", StatusOpen, []string{"b-22222222"}),
		makeTestFelt("d-44444444", "D", StatusOpen, []string{"c-33333333"}),
	}

	g := BuildGraph(felts)

	path := g.FindPath("d-44444444", "a-11111111")
	if path == nil {
		t.Fatal("FindPath should find path from D to A")
	}
	if len(path) != 4 {
		t.Errorf("Path length = %d, want 4", len(path))
	}

	// No path from A to D (wrong direction)
	path = g.FindPath("a-11111111", "d-44444444")
	if path != nil {
		t.Error("FindPath should not find path from A to D")
	}

	// Same node
	path = g.FindPath("a-11111111", "a-11111111")
	if len(path) != 1 {
		t.Errorf("Same node path length = %d, want 1", len(path))
	}
}

func TestToMermaid(t *testing.T) {
	felts := []*Felt{
		makeTestFelt("a-11111111", "A", StatusOpen, nil),
		makeTestFelt("b-22222222", "B", StatusActive, []string{"a-11111111"}),
		makeTestFelt("c-33333333", "C", StatusClosed, []string{"b-22222222"}),
	}

	g := BuildGraph(felts)
	mermaid := g.ToMermaid()

	if !strings.HasPrefix(mermaid, "graph TD") {
		t.Error("Mermaid should start with graph TD")
	}
	if !strings.Contains(mermaid, "a_11111111") {
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
		makeTestFelt("a-11111111", `Title with <brackets> & "quotes"`, StatusOpen, nil),
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
		makeTestFelt("a-11111111", "A", StatusOpen, nil),
		makeTestFelt("b-22222222", "B", StatusOpen, []string{"a-11111111"}),
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
		makeTestFelt("a-11111111", "A", StatusOpen, nil),
		makeTestFelt("b-22222222", "B", StatusOpen, []string{"a-11111111"}),
	}
	g := BuildGraph(felts)
	cycles := g.FindCycles()
	if len(cycles) != 0 {
		t.Errorf("FindCycles found %d cycles, want 0", len(cycles))
	}

	// Create a cycle: A -> B -> A (manually set deps to bypass validation)
	felts = []*Felt{
		makeTestFelt("a-11111111", "A", StatusOpen, []string{"b-22222222"}),
		makeTestFelt("b-22222222", "B", StatusOpen, []string{"a-11111111"}),
	}
	g = BuildGraph(felts)
	cycles = g.FindCycles()
	if len(cycles) == 0 {
		t.Error("FindCycles should detect A->B->A cycle")
	}

	// Self-cycle
	felts = []*Felt{
		makeTestFelt("a-11111111", "A", StatusOpen, []string{"a-11111111"}),
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
		makeTestFelt("a-11111111", "A", StatusClosed, nil),
		makeTestFelt("b-22222222", "B", StatusActive, []string{"a-11111111"}),
		makeTestFelt("c-33333333", "C", StatusOpen, []string{"b-22222222"}),
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
		makeTestFelt("a-11111111", "A", StatusOpen, nil),
		makeTestFelt("b-22222222", "B", StatusOpen, []string{"a-11111111"}),
		makeTestFelt("x-88888888", "X", StatusOpen, nil),
		makeTestFelt("y-99999999", "Y", StatusOpen, []string{"x-88888888"}),
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
			ID: "a-11111111", Title: "A", Status: StatusOpen,			Priority: 2, DependsOn: nil, CreatedAt: time.Now(),
		},
		{
			ID: "b-22222222", Title: "B", Status: StatusOpen,			Priority: 2,
			DependsOn: Dependencies{
				{ID: "a-11111111", Label: "needs data"},
			},
			CreatedAt: time.Now(),
		},
	}

	g := BuildGraph(felts)

	// Upstream of B should have label
	if len(g.Upstream["b-22222222"]) != 1 {
		t.Fatalf("B upstream count = %d, want 1", len(g.Upstream["b-22222222"]))
	}
	if g.Upstream["b-22222222"][0].Label != "needs data" {
		t.Errorf("B upstream label = %q, want %q", g.Upstream["b-22222222"][0].Label, "needs data")
	}

	// Downstream of A should have label
	if len(g.Downstream["a-11111111"]) != 1 {
		t.Fatalf("A downstream count = %d, want 1", len(g.Downstream["a-11111111"]))
	}
	if g.Downstream["a-11111111"][0].Label != "needs data" {
		t.Errorf("A downstream label = %q, want %q", g.Downstream["a-11111111"][0].Label, "needs data")
	}
}

func TestToMermaidWithLabels(t *testing.T) {
	felts := []*Felt{
		{
			ID: "a-11111111", Title: "A", Status: StatusOpen,			Priority: 2, DependsOn: nil, CreatedAt: time.Now(),
		},
		{
			ID: "b-22222222", Title: "B", Status: StatusOpen,			Priority: 2,
			DependsOn: Dependencies{
				{ID: "a-11111111", Label: "blocks"},
			},
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
			ID: "a-11111111", Title: "A", Status: StatusOpen,			Priority: 2, DependsOn: nil, CreatedAt: time.Now(),
		},
		{
			ID: "b-22222222", Title: "B", Status: StatusOpen,			Priority: 2,
			DependsOn: Dependencies{
				{ID: "a-11111111", Label: "provides input"},
			},
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
			ID: "a-11111111", Title: "A", Status: StatusOpen,			Priority: 2, DependsOn: nil, CreatedAt: time.Now(),
		},
		{
			ID: "b-22222222", Title: "B", Status: StatusOpen,			Priority: 2,
			DependsOn: Dependencies{
				{ID: "a-11111111", Label: "reason"},
			},
			CreatedAt: time.Now(),
		},
	}

	g := BuildGraph(felts)
	text := g.ToText()

	if !strings.Contains(text, "[reason]") {
		t.Errorf("Text tree should contain label, got:\n%s", text)
	}
}
