package cmd

import (
	"fmt"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var checkCmd = &cobra.Command{
	Use:   "check",
	Short: "Report broken links and store layout problems",
	Long: `Exits non-zero when it finds an error, under --json too. It reports:
  - fibers that fail to parse, which every other command skips
  - empty names
  - wikilinks, inputs.from, and depends_on ids that resolve to no fiber
  - a link whose path names no fiber but whose last segment does (a warning:
    it resolves only by that guess, which rm, nest, and unnest refuse)
  - legacy title, depends-on, and MyST anchor forms (felt migrate converts them)
  - a slug in both bare and nested form, and more than one bare .md at the
    .felt root
  - stray fiber files: a bare <dir>/<slug>.md with fiber frontmatter below the
    root, which belongs at <dir>/<slug>/<slug>.md (felt migrate folds it)
  - two entries in one directory whose names differ only by case, on disk or
    in the git index (a case-insensitive filesystem can check out only one)
  - a shuttle host: naming this machine by a pre-normalization spelling
    (a warning)`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		storage, _, err := felt.RequireStore(changeDir)
		if err != nil {
			return err
		}
		// The walk's own stderr warning about a file it skipped would duplicate
		// the issue CheckParseability raises below, and only one of the two
		// carries an exit code.
		storage.SilenceWalkWarnings()
		// Every check below walks the store; they share one walk.
		storage.MemoizeWalk()
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
		strays, err := storage.StrayFibers()
		if err != nil {
			return err
		}
		issues = append(issues, felt.Check(felts, storage.ExternalRefs(), strays...)...)
		structureIssues, err := felt.CheckStructure(storage)
		if err != nil {
			return err
		}
		issues = append(issues, structureIssues...)
		caseIssues, err := felt.CheckCaseCollisions(storage)
		if err != nil {
			return err
		}
		issues = append(issues, caseIssues...)
		legacyIssues, err := felt.CheckLegacyFormat(storage)
		if err != nil {
			return err
		}
		issues = append(issues, legacyIssues...)
		issues = append(issues, checkHostDrift(felts)...)
		errors := 0
		for _, issue := range issues {
			if issue.Level == felt.CheckLevelError {
				errors++
			}
		}
		if jsonOutput {
			if err := outputJSON(issues); err != nil {
				return err
			}
		} else if len(issues) == 0 {
			fmt.Println("Check OK")
		} else {
			for _, issue := range issues {
				fmt.Println(issue.String())
			}
		}
		if errors > 0 {
			return fmt.Errorf("check failed: %d error(s)", errors)
		}
		return nil
	},
}

func init() {
	checkCmd.GroupID = groupStore
	rootCmd.AddCommand(checkCmd)
}
