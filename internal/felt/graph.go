package felt

import (
	"fmt"
	"sort"
	"strings"
)

// Graph represents the DAG of felts with bidirectional edges.
type Graph struct {
	Nodes      map[string]*Felt         // ID -> Felt
	Upstream   map[string]Dependencies  // ID -> what this depends on
	Downstream map[string]Dependencies  // ID -> what depends on this (computed)
}

// BuildGraph constructs a graph from a list of felts.
func BuildGraph(felts []*Felt) *Graph {
	g := &Graph{
		Nodes:      make(map[string]*Felt),
		Upstream:   make(map[string]Dependencies),
		Downstream: make(map[string]Dependencies),
	}

	// First pass: index all nodes
	for _, f := range felts {
		g.Nodes[f.ID] = f
		g.Upstream[f.ID] = f.DependsOn
	}

	// Second pass: compute downstream (reverse edges)
	for id, deps := range g.Upstream {
		for _, dep := range deps {
			g.Downstream[dep.ID] = append(g.Downstream[dep.ID], Dependency{ID: id, Label: dep.Label})
		}
	}

	return g
}

// GetUpstream returns all transitive dependencies of the given ID.
// Uses BFS for level-order traversal.
func (g *Graph) GetUpstream(id string) []string {
	return g.bfs(id, g.Upstream)
}

// GetDownstream returns all nodes that transitively depend on the given ID.
// Uses BFS for level-order traversal.
func (g *Graph) GetDownstream(id string) []string {
	return g.bfs(id, g.Downstream)
}

// bfs performs breadth-first traversal from start using the given adjacency map.
func (g *Graph) bfs(start string, adj map[string]Dependencies) []string {
	visited := make(map[string]bool)
	var result []string
	queue := []string{start}
	visited[start] = true

	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]

		// Don't include start in result
		if current != start {
			result = append(result, current)
		}

		for _, dep := range adj[current] {
			if !visited[dep.ID] {
				visited[dep.ID] = true
				queue = append(queue, dep.ID)
			}
		}
	}

	return result
}

// Ready returns all open felts whose dependencies are all closed.
// Active felts are excluded — they're already being worked on.
func (g *Graph) Ready() []*Felt {
	var ready []*Felt

	for _, f := range g.Nodes {
		if !f.IsOpen() {
			continue
		}

		// Check all dependencies
		allDepsClosed := true
		for _, d := range f.DependsOn {
			dep, ok := g.Nodes[d.ID]
			if !ok {
				// Missing dependency — treat as not ready
				allDepsClosed = false
				break
			}
			if !dep.IsClosed() {
				allDepsClosed = false
				break
			}
		}

		if allDepsClosed {
			ready = append(ready, f)
		}
	}

	// Sort by creation time
	sort.Slice(ready, func(i, j int) bool {
		return ready[i].CreatedAt.Before(ready[j].CreatedAt)
	})

	return ready
}

// DetectCycle checks if adding an edge from -> to would create a cycle.
func (g *Graph) DetectCycle(from, to string) bool {
	// Would create cycle if 'from' is reachable from 'to'
	// i.e., if 'to' already depends on 'from' transitively
	upstream := g.GetUpstream(to)
	for _, id := range upstream {
		if id == from {
			return true
		}
	}
	// Also check if from == to
	return from == to
}

// FindCycles detects cycles in the graph using DFS.
// Returns a list of cycle descriptions (empty if no cycles).
func (g *Graph) FindCycles() []string {
	var cycles []string
	visited := make(map[string]int) // 0=unvisited, 1=in-stack, 2=done

	var dfs func(id string, path []string) bool
	dfs = func(id string, path []string) bool {
		if visited[id] == 1 {
			// Found cycle - find where it starts
			cycleStart := -1
			for i, p := range path {
				if p == id {
					cycleStart = i
					break
				}
			}
			if cycleStart >= 0 {
				cyclePath := append(path[cycleStart:], id)
				cycles = append(cycles, fmt.Sprintf("cycle: %s", strings.Join(cyclePath, " -> ")))
			}
			return true
		}
		if visited[id] == 2 {
			return false
		}

		visited[id] = 1
		path = append(path, id)

		for _, dep := range g.Upstream[id] {
			if _, exists := g.Nodes[dep.ID]; exists {
				dfs(dep.ID, path)
			}
		}

		visited[id] = 2
		return false
	}

	for id := range g.Nodes {
		if visited[id] == 0 {
			dfs(id, nil)
		}
	}

	return cycles
}

// ValidateDependencies checks for dangling references.
func (g *Graph) ValidateDependencies() []string {
	var errors []string

	for id, deps := range g.Upstream {
		for _, dep := range deps {
			if _, ok := g.Nodes[dep.ID]; !ok {
				errors = append(errors, fmt.Sprintf("%s depends on non-existent %s", id, dep.ID))
			}
		}
	}

	return errors
}

// FindPath returns the dependency path from 'from' to 'to', if one exists.
// Returns nil if no path exists.
func (g *Graph) FindPath(from, to string) []string {
	if from == to {
		return []string{from}
	}

	// BFS with parent tracking
	parent := make(map[string]string)
	visited := make(map[string]bool)
	queue := []string{from}
	visited[from] = true

	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]

		for _, dep := range g.Upstream[current] {
			if visited[dep.ID] {
				continue
			}
			visited[dep.ID] = true
			parent[dep.ID] = current

			if dep.ID == to {
				// Reconstruct path
				path := []string{to}
				for p := parent[to]; p != ""; p = parent[p] {
					path = append([]string{p}, path...)
				}
				return path
			}

			queue = append(queue, dep.ID)
		}
	}

	return nil
}

// ToMermaid generates a Mermaid diagram of the graph.
func (g *Graph) ToMermaid() string {
	var sb strings.Builder
	sb.WriteString("graph TD\n")

	// Sort IDs for deterministic output
	var ids []string
	for id := range g.Nodes {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	// Node definitions with status styling
	for _, id := range ids {
		f := g.Nodes[id]
		title := escapeMermaidText(f.Title)
		sb.WriteString(fmt.Sprintf("    %s[\"%s\"]\n", sanitizeMermaidID(id), title))
	}

	sb.WriteString("\n")

	// Edges
	for _, id := range ids {
		for _, dep := range g.Upstream[id] {
			// Arrow from dependency to dependent (dependency flows up)
			if dep.Label != "" {
				sb.WriteString(fmt.Sprintf("    %s -->|%s| %s\n", sanitizeMermaidID(dep.ID), escapeMermaidText(dep.Label), sanitizeMermaidID(id)))
			} else {
				sb.WriteString(fmt.Sprintf("    %s --> %s\n", sanitizeMermaidID(dep.ID), sanitizeMermaidID(id)))
			}
		}
	}

	sb.WriteString("\n")

	// Style classes
	var untrackedNodes, openNodes, activeNodes, closedNodes []string
	for _, id := range ids {
		f := g.Nodes[id]
		switch f.Status {
		case StatusOpen:
			openNodes = append(openNodes, sanitizeMermaidID(id))
		case StatusActive:
			activeNodes = append(activeNodes, sanitizeMermaidID(id))
		case StatusClosed:
			closedNodes = append(closedNodes, sanitizeMermaidID(id))
		default:
			untrackedNodes = append(untrackedNodes, sanitizeMermaidID(id))
		}
	}

	if len(untrackedNodes) > 0 {
		sb.WriteString(fmt.Sprintf("    class %s untracked\n", strings.Join(untrackedNodes, ",")))
	}
	if len(openNodes) > 0 {
		sb.WriteString(fmt.Sprintf("    class %s open\n", strings.Join(openNodes, ",")))
	}
	if len(activeNodes) > 0 {
		sb.WriteString(fmt.Sprintf("    class %s active\n", strings.Join(activeNodes, ",")))
	}
	if len(closedNodes) > 0 {
		sb.WriteString(fmt.Sprintf("    class %s closed\n", strings.Join(closedNodes, ",")))
	}

	sb.WriteString("\n    classDef untracked fill:#f5f5f5,stroke:#999\n")
	sb.WriteString("    classDef open fill:#fff,stroke:#333\n")
	sb.WriteString("    classDef active fill:#ffd,stroke:#333\n")
	sb.WriteString("    classDef closed fill:#dfd,stroke:#333\n")

	return sb.String()
}

// ToDot generates a Graphviz DOT diagram.
func (g *Graph) ToDot() string {
	var sb strings.Builder
	sb.WriteString("digraph felt {\n")
	sb.WriteString("    rankdir=BT;\n")
	sb.WriteString("    node [shape=box];\n\n")

	// Sort IDs for deterministic output
	var ids []string
	for id := range g.Nodes {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	// Node definitions
	for _, id := range ids {
		f := g.Nodes[id]
		title := strings.ReplaceAll(f.Title, "\"", "\\\"")
		style := ""
		switch f.Status {
		case StatusActive:
			style = ",style=filled,fillcolor=lightyellow"
		case StatusClosed:
			style = ",style=filled,fillcolor=lightgreen"
		case "":
			style = ",style=filled,fillcolor=whitesmoke"
		}
		sb.WriteString(fmt.Sprintf("    \"%s\" [label=\"%s\"%s];\n", id, title, style))
	}

	sb.WriteString("\n")

	// Edges
	for _, id := range ids {
		for _, dep := range g.Upstream[id] {
			if dep.Label != "" {
				label := strings.ReplaceAll(dep.Label, "\"", "\\\"")
				sb.WriteString(fmt.Sprintf("    \"%s\" -> \"%s\" [label=\"%s\"];\n", dep.ID, id, label))
			} else {
				sb.WriteString(fmt.Sprintf("    \"%s\" -> \"%s\";\n", dep.ID, id))
			}
		}
	}

	sb.WriteString("}\n")
	return sb.String()
}

// sanitizeMermaidID makes an ID safe for use in Mermaid diagrams.
func sanitizeMermaidID(id string) string {
	// Replace hyphens with underscores (Mermaid doesn't like hyphens in IDs)
	return strings.ReplaceAll(id, "-", "_")
}

// escapeMermaidText escapes special characters in text for Mermaid diagrams.
// Mermaid uses HTML rendering, so we need to escape HTML entities and quotes.
func escapeMermaidText(s string) string {
	// Order matters: escape & first to avoid double-escaping
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, "\"", "&quot;")
	return s
}

// ToText generates an ASCII text representation of the graph.
// Shows all nodes with their edges in a simple text format.
func (g *Graph) ToText() string {
	var sb strings.Builder

	// Sort IDs for deterministic output
	var ids []string
	for id := range g.Nodes {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	// Find root nodes (no upstream deps)
	var roots []string
	for _, id := range ids {
		if len(g.Upstream[id]) == 0 {
			roots = append(roots, id)
		}
	}

	// Print from each root
	printed := make(map[string]bool)
	for _, root := range roots {
		g.printTextTree(&sb, root, "", "", true, printed)
	}

	// Print any orphaned nodes (in cycles or disconnected)
	for _, id := range ids {
		if !printed[id] {
			g.printTextTree(&sb, id, "", "", true, printed)
		}
	}

	return sb.String()
}

// printTextTree recursively prints a node and its downstream children.
// edgeLabel is the label on the edge from parent to this node (empty for roots).
func (g *Graph) printTextTree(sb *strings.Builder, id string, prefix string, edgeLabel string, last bool, printed map[string]bool) {
	if printed[id] {
		return
	}
	printed[id] = true

	f := g.Nodes[id]
	if f == nil {
		return
	}

	// Status indicator
	statusChar := "·"
	switch f.Status {
	case StatusOpen:
		statusChar = "○"
	case StatusActive:
		statusChar = "◐"
	case StatusClosed:
		statusChar = "●"
	}

	// Branch character
	branch := "├── "
	if last {
		branch = "└── "
	}
	if prefix == "" {
		branch = ""
	}

	// Truncate ID for display
	displayID := id
	if len(displayID) > 20 {
		parts := strings.Split(id, "-")
		if len(parts) >= 2 {
			hex := parts[len(parts)-1]
			slug := strings.Join(parts[:len(parts)-1], "-")
			if len(slug) > 12 {
				slug = slug[:12] + "…"
			}
			displayID = slug + "-" + hex
		}
	}

	labelPart := ""
	if edgeLabel != "" {
		labelPart = fmt.Sprintf(" [%s]", edgeLabel)
	}

	sb.WriteString(fmt.Sprintf("%s%s%s %s%s  %s\n", prefix, branch, statusChar, displayID, labelPart, f.Title))

	// Get and sort children by ID
	children := g.Downstream[id]
	sort.Slice(children, func(i, j int) bool {
		return children[i].ID < children[j].ID
	})

	// Calculate child prefix
	childPrefix := prefix
	if prefix != "" {
		if last {
			childPrefix += "    "
		} else {
			childPrefix += "│   "
		}
	} else {
		childPrefix = "    "
	}

	for i, child := range children {
		g.printTextTree(sb, child.ID, childPrefix, child.Label, i == len(children)-1, printed)
	}
}
