package cmd

import (
	"fmt"
	"sort"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var (
	linksUp   bool
	linksDown bool
	linksAll  bool
)

var linksCmd = &cobra.Command{
	Use:   "links [id]",
	Short: "Show dependency edges with labels",
	Long: `Shows dependency edges for one fiber or all fibers in the project.

Without an ID, lists all fibers that have edges (upstream or downstream).
With an ID, shows its direct dependencies (↑) and dependents (↓).

Use --up or --down to restrict direction. Use --all for the full transitive
closure instead of direct (1-level) edges.

Graph export and validation:
  felt links --format mermaid   emit Mermaid diagram
  felt links --format dot       emit Graphviz DOT
  felt links --check            validate graph integrity`,
	Args: cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := resolveProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}

		storage := felt.NewStorage(root)
		var felts []*felt.Felt
		if jsonOutput {
			felts, err = storage.ListMetadataWithModTime()
		} else {
			felts, err = storage.ListMetadata()
		}
		if err != nil {
			return err
		}

		g := felt.BuildGraph(felts)

		// --check: validate graph integrity
		if linksCheck {
			var errors []string
			errors = append(errors, g.ValidateDependencies()...)
			errors = append(errors, g.FindCycles()...)

			if len(errors) == 0 {
				fmt.Println("Graph OK")
				return nil
			}
			for _, e := range errors {
				fmt.Printf("ERROR: %s\n", e)
			}
			return fmt.Errorf("found %d issues", len(errors))
		}

		// --format: graph export
		if graphFormat != "" && graphFormat != "text" {
			switch graphFormat {
			case "mermaid":
				fmt.Print(g.ToMermaid())
			case "dot":
				fmt.Print(g.ToDot())
			default:
				return fmt.Errorf("unknown format: %s (use mermaid, dot, or text)", graphFormat)
			}
			return nil
		}

		depth := 1
		if linksAll {
			depth = 0
		}

		// With an ID: show edges for one fiber
		if len(args) == 1 {
			f, err := felt.FindByPrefix(felts, args[0])
			if err != nil {
				return err
			}

			if jsonOutput {
				return outputLinksJSON(g, f.ID, linksUp, linksDown, depth)
			}

			return printLinksForFiber(g, f.ID, linksUp, linksDown, depth)
		}

		// No ID: list all fibers that have edges
		if jsonOutput {
			return outputAllLinksJSON(g, felts, linksUp, linksDown, depth)
		}

		return printAllLinks(g, felts, linksUp, linksDown, depth)
	},
}

// printLinksForFiber prints the edge view for a single fiber.
func printLinksForFiber(g *felt.Graph, id string, upOnly, downOnly bool, depth int) error {
	f := g.Nodes[id]
	if f == nil {
		return fmt.Errorf("fiber not found: %s", id)
	}

	showUp := !downOnly
	showDown := !upOnly

	upstream := linksGetRelated(g, id, true, depth)
	downstream := linksGetRelated(g, id, false, depth)

	if showUp && len(upstream) == 0 && (!showDown || len(downstream) == 0) {
		fmt.Println("No edges")
		return nil
	}
	if !showUp && showDown && len(downstream) == 0 {
		fmt.Println("Nothing depends on this")
		return nil
	}
	if showUp && !showDown && len(upstream) == 0 {
		fmt.Println("No dependencies")
		return nil
	}

	fmt.Printf("%s %s\n", felt.StatusIcon(f.Status), felt.ShortID(id))

	if showUp {
		for _, depID := range upstream {
			dep := g.Nodes[depID]
			if dep == nil {
				continue
			}
			label := g.Upstream[id].LabelFor(depID)
			if depth != 1 {
				// For transitive, find label via the direct edge if available
				label = upstreamEdgeLabel(g, id, depID)
			}
			printEdgeLine("↑", dep, label)
		}
	}

	if showDown {
		for _, depID := range downstream {
			dep := g.Nodes[depID]
			if dep == nil {
				continue
			}
			label := g.Upstream[depID].LabelFor(id)
			if depth != 1 {
				label = downstreamEdgeLabel(g, id, depID)
			}
			printEdgeLine("↓", dep, label)
		}
	}

	return nil
}

// printAllLinks lists all fibers with edges, grouped by fiber.
func printAllLinks(g *felt.Graph, felts []*felt.Felt, upOnly, downOnly bool, depth int) error {
	showUp := !downOnly
	showDown := !upOnly

	// Sort fibers for deterministic output
	sorted := make([]*felt.Felt, len(felts))
	copy(sorted, felts)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i].CreatedAt.Before(sorted[j].CreatedAt)
	})

	any := false
	for _, f := range sorted {
		upstream := linksGetRelated(g, f.ID, true, depth)
		downstream := linksGetRelated(g, f.ID, false, depth)

		hasEdges := (showUp && len(upstream) > 0) || (showDown && len(downstream) > 0)
		if !hasEdges {
			continue
		}

		any = true
		fmt.Printf("%s %s\n", felt.StatusIcon(f.Status), felt.ShortID(f.ID))

		if showUp {
			for _, depID := range upstream {
				dep := g.Nodes[depID]
				if dep == nil {
					continue
				}
				label := g.Upstream[f.ID].LabelFor(depID)
				printEdgeLine("↑", dep, label)
			}
		}
		if showDown {
			for _, depID := range downstream {
				dep := g.Nodes[depID]
				if dep == nil {
					continue
				}
				label := g.Upstream[depID].LabelFor(f.ID)
				printEdgeLine("↓", dep, label)
			}
		}
	}

	if !any {
		fmt.Println("No edges found")
	}
	return nil
}

// printEdgeLine formats a single edge line.
func printEdgeLine(arrow string, f *felt.Felt, label string) {
	if label != "" {
		fmt.Printf("  %s %s — %s\n", arrow, felt.ShortID(f.ID), label)
	} else {
		fmt.Printf("  %s %s\n", arrow, felt.ShortID(f.ID))
	}
}

// linksGetRelated returns upstream or downstream IDs respecting depth.
func linksGetRelated(g *felt.Graph, id string, upstream bool, depth int) []string {
	if upstream {
		return g.GetUpstreamN(id, depth)
	}
	return g.GetDownstreamN(id, depth)
}

// upstreamEdgeLabel finds a label for an upstream edge, searching the direct edge first.
// For transitive edges, returns empty string (no direct label available).
func upstreamEdgeLabel(g *felt.Graph, fiberID, depID string) string {
	return g.Upstream[fiberID].LabelFor(depID)
}

// downstreamEdgeLabel finds a label for a downstream edge (depID depends on fiberID).
func downstreamEdgeLabel(g *felt.Graph, fiberID, depID string) string {
	return g.Upstream[depID].LabelFor(fiberID)
}

// --- JSON output types ---

type linksEdge struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
	Label  string `json:"label,omitempty"`
}

type linksNode struct {
	ID         string      `json:"id"`
	Name       string      `json:"name"`
	Status     string      `json:"status"`
	Upstream   []linksEdge `json:"upstream,omitempty"`
	Downstream []linksEdge `json:"downstream,omitempty"`
}

func outputLinksJSON(g *felt.Graph, id string, upOnly, downOnly bool, depth int) error {
	f := g.Nodes[id]
	if f == nil {
		return fmt.Errorf("fiber not found: %s", id)
	}
	node := buildLinksNode(g, f, upOnly, downOnly, depth)
	return outputJSON(node)
}

func outputAllLinksJSON(g *felt.Graph, felts []*felt.Felt, upOnly, downOnly bool, depth int) error {
	var nodes []linksNode
	for _, f := range felts {
		node := buildLinksNode(g, f, upOnly, downOnly, depth)
		if len(node.Upstream) > 0 || len(node.Downstream) > 0 {
			nodes = append(nodes, node)
		}
	}
	return outputJSON(nodes)
}

func buildLinksNode(g *felt.Graph, f *felt.Felt, upOnly, downOnly bool, depth int) linksNode {
	showUp := !downOnly
	showDown := !upOnly

	node := linksNode{
		ID:     f.ID,
		Name:   f.DisplayName(),
		Status: f.Status,
	}

	if showUp {
		for _, depID := range linksGetRelated(g, f.ID, true, depth) {
			dep := g.Nodes[depID]
			if dep == nil {
				continue
			}
			node.Upstream = append(node.Upstream, linksEdge{
				ID:     dep.ID,
				Name:   dep.DisplayName(),
				Status: dep.Status,
				Label:  g.Upstream[f.ID].LabelFor(depID),
			})
		}
	}

	if showDown {
		for _, depID := range linksGetRelated(g, f.ID, false, depth) {
			dep := g.Nodes[depID]
			if dep == nil {
				continue
			}
			node.Downstream = append(node.Downstream, linksEdge{
				ID:     dep.ID,
				Name:   dep.DisplayName(),
				Status: dep.Status,
				Label:  g.Upstream[depID].LabelFor(f.ID),
			})
		}
	}

	return node
}

var linksCheck bool

func init() {
	linksCmd.Flags().BoolVar(&linksUp, "up", false, "Show upstream dependencies only")
	linksCmd.Flags().BoolVar(&linksDown, "down", false, "Show downstream dependents only")
	linksCmd.Flags().BoolVar(&linksAll, "all", false, "Traverse full transitive closure (default is direct only)")
	linksCmd.Flags().StringVarP(&graphFormat, "format", "f", "", "Output format for graph export (mermaid, dot, text)")
	linksCmd.Flags().BoolVar(&linksCheck, "check", false, "Validate graph integrity")
}
