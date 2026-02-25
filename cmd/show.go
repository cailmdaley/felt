package cmd

import (
	"fmt"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var (
	showBodyOnly bool
	showDetail   string
)

var showCmd = &cobra.Command{
	Use:   "show <id>",
	Short: "Show details of a felt",
	Long: `Displays details of a felt at the requested detail level.

Detail levels control progressive disclosure:
  title    Title and tags only
  compact  Structured overview: metadata, outcome, dependency IDs
  summary  Compact + lede paragraph + dependency titles
  full     Everything (default)`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := felt.FindProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}

		detail := showDetail
		if detail == "" {
			detail = DepthFull
		}
		if err := validateDepth(detail); err != nil {
			return err
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

		fmt.Print(renderFelt(f, graph, detail))
		return nil
	},
}

func init() {
	rootCmd.AddCommand(showCmd)
	showCmd.Flags().BoolVarP(&showBodyOnly, "body", "b", false, "Output only the body (for piping)")
	showCmd.Flags().StringVarP(&showDetail, "detail", "d", "", "Detail level (title, compact, summary, full)")
}
