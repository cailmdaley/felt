package cmd

import (
	"fmt"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var checkCmd = &cobra.Command{
	Use:   "check",
	Short: "Lint fibers for structural quality issues",
	Long: `Runs felt's repository checks.

Current checks cover:
  - broken narrative wikilinks / body references
  - broken inputs.from data-flow references
  - legacy title frontmatter keys
  - legacy depends-on frontmatter keys
  - legacy MyST body anchors
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
		if errors > 0 {
			return fmt.Errorf("check failed: %d error(s), %d warning(s)", errors, warnings)
		}
		fmt.Printf("Check OK with %d warning(s)\n", warnings)
		return nil
	},
}

func init() {
	rootCmd.AddCommand(checkCmd)
}
