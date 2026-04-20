package cmd

import (
	"fmt"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var checkCmd = &cobra.Command{
	Use:   "check",
	Short: "Lint fibers for structural and ASTRA quality issues",
	Long: `Runs felt's repository checks.

Current checks cover:
  - broken narrative wikilinks / body references
  - broken ASTRA inputs.from references
  - legacy title frontmatter keys
  - legacy depends-on frontmatter keys
  - legacy MyST body anchors
  - decisions without options
  - decisions with no remaining unexcluded options
  - insights without evidence
  - evidence stubs without description or anchors
  - closed fibers with unselected decisions
  - inconsistent ASTRA formalization depth across siblings
  - slug collisions between bare and nested fiber forms
  - multiple bare .md files at .felt/ root`,
	Args:         cobra.NoArgs,
	SilenceUsage: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := resolveProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}

		storage := felt.NewStorage(root)
		felts, err := storage.List()
		if err != nil {
			return err
		}

		issues := felt.Check(felts)
		structureIssues, err := felt.CheckStructure(storage)
		if err != nil {
			return err
		}
		issues = append(issues, structureIssues...)
		legacyIssues, err := felt.CheckLegacyFormat(storage)
		if err != nil {
			return err
		}
		issues = append(issues, legacyIssues...)
		if jsonOutput {
			return outputJSON(issues)
		}
		if len(issues) == 0 {
			fmt.Println("Check OK")
			return nil
		}

		errors := 0
		warnings := 0
		for _, issue := range issues {
			fmt.Println(issue.String())
			switch issue.Level {
			case felt.CheckLevelError:
				errors++
			case felt.CheckLevelWarn:
				warnings++
			}
		}
		return fmt.Errorf("check failed: %d error(s), %d warning(s)", errors, warnings)
	},
}

func init() {
	rootCmd.AddCommand(checkCmd)
}
