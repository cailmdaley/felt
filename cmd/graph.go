package cmd

import (
	"fmt"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var (
	graphFormat  string
	upDownDetail string
	traversalAll bool
)

var graphCmd = &cobra.Command{
	Use:   "graph",
	Short: "Visualize the dependency graph",
	Long:  `Outputs the dependency graph in various formats.`,
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := felt.FindProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}

		storage := felt.NewStorage(root)
		felts, err := storage.List()
		if err != nil {
			return err
		}

		if len(felts) == 0 {
			fmt.Println("No felts to graph")
			return nil
		}

		g := felt.BuildGraph(felts)

		switch graphFormat {
		case "mermaid":
			fmt.Print(g.ToMermaid())
		case "dot":
			fmt.Print(g.ToDot())
		case "text":
			fmt.Print(g.ToText())
		default:
			return fmt.Errorf("unknown format: %s (use mermaid, dot, or text)", graphFormat)
		}

		return nil
	},
}

var upstreamCmd = &cobra.Command{
	Use:   "upstream <id>",
	Short: "Show what a felt depends on",
	Long: `Lists dependencies of a felt.

By default shows direct dependencies only (depth 1).
Use --all for the full transitive closure (all ancestors).
Use -d/--detail to control detail level per item.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		depth := 1
		if traversalAll {
			depth = 0
		}
		return runTraversal(args[0], traversalConfig{
			getRelated: func(g *felt.Graph, id string) []string { return g.GetUpstreamN(id, depth) },
			edgeLabel:  func(g *felt.Graph, fiberID, relatedID string) string { return edgeLabelInGraph(g, relatedID, fiberID) },
			emptyMsg:   "No dependencies",
		})
	},
}

var downstreamCmd = &cobra.Command{
	Use:   "downstream <id>",
	Short: "Show what depends on a felt",
	Long: `Lists felts that depend on this one.

By default shows direct dependents only (depth 1).
Use --all for the full transitive closure (all descendants).
Use -d/--detail to control detail level per item.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		depth := 1
		if traversalAll {
			depth = 0
		}
		return runTraversal(args[0], traversalConfig{
			getRelated: func(g *felt.Graph, id string) []string { return g.GetDownstreamN(id, depth) },
			edgeLabel:  func(g *felt.Graph, fiberID, relatedID string) string { return edgeLabelInGraph(g, fiberID, relatedID) },
			emptyMsg:   "Nothing depends on this",
		})
	},
}

// traversalConfig captures the differences between upstream and downstream traversal.
type traversalConfig struct {
	getRelated func(g *felt.Graph, id string) []string
	edgeLabel  func(g *felt.Graph, fiberID, relatedID string) string
	emptyMsg   string
}

// runTraversal implements the shared logic for upstream and downstream commands.
func runTraversal(fiberArg string, cfg traversalConfig) error {
	root, err := felt.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("not in a felt repository")
	}

	if upDownDetail != "" {
		if err := validateDepth(upDownDetail); err != nil {
			return err
		}
	}

	storage := felt.NewStorage(root)
	f, err := storage.Find(fiberArg)
	if err != nil {
		return err
	}

	felts, err := storage.List()
	if err != nil {
		return err
	}

	g := felt.BuildGraph(felts)
	related := cfg.getRelated(g, f.ID)

	if jsonOutput {
		var deps []*felt.Felt
		for _, id := range related {
			if dep := g.Nodes[id]; dep != nil {
				deps = append(deps, dep)
			}
		}
		return outputJSON(deps)
	}

	if len(related) == 0 {
		fmt.Println(cfg.emptyMsg)
		return nil
	}

	// Depth-aware rendering
	if upDownDetail != "" {
		for i, id := range related {
			dep := g.Nodes[id]
			if dep != nil {
				fmt.Print(renderFelt(dep, g, upDownDetail))
				if upDownDetail != DepthTitle && i < len(related)-1 {
					fmt.Println()
				}
			}
		}
		return nil
	}

	// Default: single-line format
	for _, id := range related {
		dep := g.Nodes[id]
		if dep != nil {
			label := cfg.edgeLabel(g, f.ID, id)
			if label != "" {
				fmt.Printf("%s %s  %s [%s]\n", statusIcon(dep.Status), dep.ID, dep.Title, label)
			} else {
				fmt.Printf("%s %s  %s\n", statusIcon(dep.Status), dep.ID, dep.Title)
			}
		}
	}

	return nil
}

// edgeLabelInGraph finds the label on the edge from depID to dependentID.
// It looks for depID in dependentID's upstream deps.
func edgeLabelInGraph(g *felt.Graph, depID, dependentID string) string {
	for _, d := range g.Upstream[dependentID] {
		if d.ID == depID {
			return d.Label
		}
	}
	return ""
}

var pathCmd = &cobra.Command{
	Use:   "path <from> <to>",
	Short: "Find dependency path between two felts",
	Long:  `Shows the dependency path from one felt to another.`,
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := felt.FindProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}

		storage := felt.NewStorage(root)

		from, err := storage.Find(args[0])
		if err != nil {
			return fmt.Errorf("from: %w", err)
		}

		to, err := storage.Find(args[1])
		if err != nil {
			return fmt.Errorf("to: %w", err)
		}

		felts, err := storage.List()
		if err != nil {
			return err
		}

		g := felt.BuildGraph(felts)
		path := g.FindPath(from.ID, to.ID)

		if path == nil {
			fmt.Printf("No path from %s to %s\n", from.ID, to.ID)
			return nil
		}

		for i, id := range path {
			f := g.Nodes[id]
			prefix := "  "
			if i == 0 {
				prefix = "→ "
			}
			fmt.Printf("%s%s %s  %s\n", prefix, statusIcon(f.Status), f.ID, f.Title)
		}

		return nil
	},
}

var checkCmd = &cobra.Command{
	Use:   "check",
	Short: "Check graph integrity",
	Long:  `Validates the dependency graph for dangling references and cycles.`,
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := felt.FindProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}

		storage := felt.NewStorage(root)
		felts, err := storage.List()
		if err != nil {
			return err
		}

		g := felt.BuildGraph(felts)

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
	},
}

func init() {
	rootCmd.AddCommand(graphCmd)
	rootCmd.AddCommand(upstreamCmd)
	rootCmd.AddCommand(downstreamCmd)
	rootCmd.AddCommand(pathCmd)
	rootCmd.AddCommand(checkCmd)

	graphCmd.Flags().StringVarP(&graphFormat, "format", "f", "mermaid", "Output format (mermaid, dot, text)")
	upstreamCmd.Flags().StringVarP(&upDownDetail, "detail", "d", "", "Detail level per item (title, compact, summary, full)")
	downstreamCmd.Flags().StringVarP(&upDownDetail, "detail", "d", "", "Detail level per item (title, compact, summary, full)")
	upstreamCmd.Flags().BoolVar(&traversalAll, "all", false, "Traverse full transitive closure (all ancestors)")
	downstreamCmd.Flags().BoolVar(&traversalAll, "all", false, "Traverse full transitive closure (all descendants)")
}
