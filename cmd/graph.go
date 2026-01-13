package cmd

import (
	"fmt"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var graphFormat string

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
	Long:  `Lists all transitive dependencies of a felt.`,
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := felt.FindProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}

		storage := felt.NewStorage(root)
		f, err := storage.Find(args[0])
		if err != nil {
			return err
		}

		felts, err := storage.List()
		if err != nil {
			return err
		}

		g := felt.BuildGraph(felts)
		upstream := g.GetUpstream(f.ID)

		if jsonOutput {
			var deps []*felt.Felt
			for _, id := range upstream {
				if dep := g.Nodes[id]; dep != nil {
					deps = append(deps, dep)
				}
			}
			return outputJSON(deps)
		}

		if len(upstream) == 0 {
			fmt.Println("No dependencies")
			return nil
		}

		for _, id := range upstream {
			dep := g.Nodes[id]
			if dep != nil {
				fmt.Printf("%s %s  %s\n", statusIcon(dep.Status), dep.ID, dep.Title)
			}
		}

		return nil
	},
}

var downstreamCmd = &cobra.Command{
	Use:   "downstream <id>",
	Short: "Show what depends on a felt",
	Long:  `Lists all felts that transitively depend on this one.`,
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := felt.FindProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}

		storage := felt.NewStorage(root)
		f, err := storage.Find(args[0])
		if err != nil {
			return err
		}

		felts, err := storage.List()
		if err != nil {
			return err
		}

		g := felt.BuildGraph(felts)
		downstream := g.GetDownstream(f.ID)

		if jsonOutput {
			var deps []*felt.Felt
			for _, id := range downstream {
				if dep := g.Nodes[id]; dep != nil {
					deps = append(deps, dep)
				}
			}
			return outputJSON(deps)
		}

		if len(downstream) == 0 {
			fmt.Println("Nothing depends on this")
			return nil
		}

		for _, id := range downstream {
			dep := g.Nodes[id]
			if dep != nil {
				fmt.Printf("%s %s  %s\n", statusIcon(dep.Status), dep.ID, dep.Title)
			}
		}

		return nil
	},
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
}
