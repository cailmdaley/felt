package cmd

import (
	"fmt"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var showBodyOnly bool

var showCmd = &cobra.Command{
	Use:   "show <id>",
	Short: "Show details of a felt",
	Long:  `Displays the full details of a felt including its body.`,
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

		// --body flag: output only the body (for piping)
		if showBodyOnly {
			fmt.Print(f.Body)
			return nil
		}

		if jsonOutput {
			return outputJSON(f)
		}

		// Build graph for downstream lookup
		felts, err := storage.List()
		if err != nil {
			return err
		}
		graph := felt.BuildGraph(felts)

		// Header
		fmt.Printf("ID:       %s\n", f.ID)
		fmt.Printf("Title:    %s\n", f.Title)
		fmt.Printf("Status:   %s\n", f.Status)
		if f.Kind != felt.DefaultKind {
			fmt.Printf("Kind:     %s\n", f.Kind)
		}
		if len(f.Tags) > 0 {
			fmt.Printf("Tags:     %s\n", strings.Join(f.Tags, ", "))
		}
		fmt.Printf("Priority: %d\n", f.Priority)

		// Dependencies (upstream - what this depends on)
		if len(f.DependsOn) > 0 {
			fmt.Printf("Upstream: %s\n", formatDeps(graph, f.DependsOn))
		}

		// Dependents (downstream - what depends on this)
		downstream := graph.Downstream[f.ID]
		if len(downstream) > 0 {
			fmt.Printf("Downstream: %s\n", formatDeps(graph, downstream))
		}

		if f.Due != nil {
			fmt.Printf("Due:      %s\n", f.Due.Format("2006-01-02"))
		}
		fmt.Printf("Created:  %s\n", f.CreatedAt.Format("2006-01-02T15:04:05-07:00"))
		if f.ClosedAt != nil {
			fmt.Printf("Closed:   %s\n", f.ClosedAt.Format("2006-01-02T15:04:05-07:00"))
		}
		if f.CloseReason != "" {
			fmt.Printf("Reason:   %s\n", f.CloseReason)
		}

		// Body
		if f.Body != "" {
			fmt.Printf("\n%s\n", f.Body)
		}

		return nil
	},
}

// formatDeps formats dependency IDs, showing title for context
func formatDeps(g *felt.Graph, ids []string) string {
	if len(ids) == 0 {
		return ""
	}
	if len(ids) == 1 {
		if f, ok := g.Nodes[ids[0]]; ok {
			return fmt.Sprintf("%s (%s)", ids[0], truncateTitle(f.Title, 30))
		}
		return ids[0]
	}
	// Multiple deps: list on separate lines
	var lines []string
	for _, id := range ids {
		if f, ok := g.Nodes[id]; ok {
			lines = append(lines, fmt.Sprintf("\n  - %s (%s)", id, truncateTitle(f.Title, 30)))
		} else {
			lines = append(lines, fmt.Sprintf("\n  - %s", id))
		}
	}
	return strings.Join(lines, "")
}

// truncateTitle shortens a title to maxLen chars
func truncateTitle(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen-1] + "…"
}

func init() {
	rootCmd.AddCommand(showCmd)
	showCmd.Flags().BoolVarP(&showBodyOnly, "body", "b", false, "Output only the body (for piping)")
}
