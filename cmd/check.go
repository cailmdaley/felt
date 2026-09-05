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
  - fibers that fail to parse (invisible to every other command)
  - broken narrative wikilinks / body references
  - broken inputs.from data-flow references
  - legacy title frontmatter keys
  - legacy depends-on frontmatter keys
  - legacy MyST body anchors
  - slug collisions between bare and nested fiber forms
  - multiple bare .md files at .felt/ root
  - a shuttle host: that is this machine under a pre-normalization name`,
	Args:         cobra.NoArgs,
	SilenceUsage: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		storage, _, err := requireStore()
		if err != nil {
			return err
		}
		// The walk's own stderr warning about a file it skipped would duplicate
		// the issue CheckParseability raises below, and only one of the two
		// carries an exit code.
		storage.SilenceWalkWarnings()
		felts, err := storage.List()
		if err != nil {
			return err
		}

		// Parseability leads. Every other check runs over the fibers that
		// parsed, so an unparseable one is absent from their input entirely —
		// it would be reported by nothing at all if this didn't run, and it is
		// the most serious thing check can find: the fiber is gone from the
		// assemblage, not merely blemished.
		issues, err := felt.CheckParseability(storage)
		if err != nil {
			return err
		}
		issues = append(issues, felt.Check(felts, storage.ExternalRefs())...)
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
		issues = append(issues, checkHostDrift(felts)...)
		if jsonOutput {
			return outputJSON(issues)
		}
		if len(issues) == 0 {
			fmt.Println("Check OK")
			return nil
		}

		errors := 0
		for _, issue := range issues {
			fmt.Println(issue.String())
			if issue.Level == felt.CheckLevelError {
				errors++
			}
		}
		if errors > 0 {
			return fmt.Errorf("check failed: %d error(s)", errors)
		}
		return nil
	},
}

func init() {
	rootCmd.AddCommand(checkCmd)
}
