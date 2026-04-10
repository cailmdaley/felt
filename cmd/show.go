package cmd

import (
	"fmt"
	"os"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

var (
	showBodyOnly  bool
	showDetail    string
	showInputs    bool
	showInsights  bool
	showDecision  string
	showDecisions bool
)

var showCmd = &cobra.Command{
	Use:   "show <id>",
	Short: "Show details of a felt",
	Long: `Displays details of a felt at the requested detail level.

Detail levels control progressive disclosure:
  title    Title and tags only
  compact  Metadata, outcome, and ASTRA counts
  summary  Compact + lede paragraph + concise ASTRA summary
  full     Everything (default)

Targeted views:
  --body            return the body plus its start line for editing
  --decisions       return all decisions only
  --decision <id>   return one decision only
  --inputs          return inputs only
  --insights        return insights only`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := resolveProjectRoot()
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

		selectorCount := 0
		for _, active := range []bool{
			showBodyOnly,
			showInputs,
			showInsights,
			showDecisions,
			showDecision != "",
		} {
			if active {
				selectorCount++
			}
		}
		if selectorCount > 1 {
			return fmt.Errorf("show selectors are mutually exclusive: choose only one of --body, --decisions, --decision, --inputs, or --insights")
		}

		storage := felt.NewStorage(root)
		scopeID := resolveCommandScope(root)
		idx, err := storage.OpenIndex()
		if err != nil {
			return err
		}
		defer idx.Close()

		// Targeted views: full single-file read, optionally structured output.
		if selectorCount > 0 || jsonOutput {
			f, err := storage.FindInScope(scopeID, args[0])
			if err != nil {
				return err
			}

			if showBodyOnly {
				return outputShowBody(storage, f)
			}
			if showDecisions {
				return outputShowSelection(f.Decisions)
			}
			if showDecision != "" {
				decision, ok := f.Decisions[showDecision]
				if !ok {
					return fmt.Errorf("decision %q not found in %s", showDecision, f.ID)
				}
				return outputShowSelection(map[string]felt.ASTRADecision{showDecision: decision})
			}
			if showInputs {
				return outputShowSelection(f.Inputs)
			}
			if showInsights {
				return outputShowSelection(f.Insights)
			}
			if jsonOutput {
				return outputJSON(f)
			}
		}

		felts, err := storage.ListMetadata()
		if err != nil {
			return err
		}
		target, err := felt.FindByScope(felts, scopeID, args[0])
		if err != nil {
			return err
		}
		graph := felt.BuildGraph(felts)

		f := target
		if detail == DepthSummary || detail == DepthFull {
			f, err = storage.Read(target.ID)
			if err != nil {
				return err
			}
			graph.Nodes[f.ID] = f
		}

		citations, err := idx.Citations(f.ID)
		if err != nil {
			return err
		}

		fmt.Print(renderFelt(f, graph, detail, citations))
		return nil
	},
}

func init() {
	rootCmd.AddCommand(showCmd)
	showCmd.Flags().BoolVarP(&showBodyOnly, "body", "b", false, "Output the body plus its start line")
	showCmd.Flags().StringVarP(&showDetail, "detail", "d", "", "Detail level (title, compact, summary, full)")
	showCmd.Flags().BoolVar(&showDecisions, "decisions", false, "Output decisions only")
	showCmd.Flags().StringVar(&showDecision, "decision", "", "Output one decision by ID")
	showCmd.Flags().BoolVar(&showInputs, "inputs", false, "Output inputs only")
	showCmd.Flags().BoolVar(&showInsights, "insights", false, "Output insights only")
}

type showBodyOutput struct {
	Body          string `json:"body" yaml:"body"`
	BodyStartLine int    `json:"body_start_line" yaml:"body_start_line"`
}

func outputShowBody(storage *felt.Storage, f *felt.Felt) error {
	data, err := os.ReadFile(storage.Path(f.ID))
	if err != nil {
		return fmt.Errorf("reading file %s: %w", storage.Path(f.ID), err)
	}
	startLine, err := felt.BodyStartLine(data)
	if err != nil {
		return err
	}

	payload := showBodyOutput{
		Body:          f.Body,
		BodyStartLine: startLine,
	}
	if jsonOutput {
		return outputJSON(payload)
	}

	fmt.Printf("Body start line: %d\n", startLine)
	if f.Body != "" {
		fmt.Printf("\n%s", f.Body)
		if f.Body[len(f.Body)-1] != '\n' {
			fmt.Println()
		}
	}
	return nil
}

func outputShowSelection(v interface{}) error {
	if jsonOutput {
		return outputJSON(v)
	}
	data, err := yaml.Marshal(v)
	if err != nil {
		return fmt.Errorf("marshal show selection: %w", err)
	}
	fmt.Print(string(data))
	return nil
}
