package cmd

import (
	"fmt"
	"os"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var (
	addBody     string
	addStatus   string
	addDue      string
	addTags     []string
	addOutcome  string
	addTopLevel bool
)

var addCmd = &cobra.Command{
	Use:   "add <slug> <name>",
	Short: "Create a new felt",
	Long: `Creates a new felt with the given slug and name.

The slug is the fiber's path/ID shorthand. The name is the first real content
and is required explicitly.

When the leading segment of <slug> matches an existing fiber's basename, the
new fiber is created under that fiber's parent — so 'felt add launch/log' lands
under an existing 'project/launch' as 'project/launch/log'. Use --top-level to
skip resolution and create at the root even when nested matches exist;
ambiguous matches (the leading segment appears in multiple subtrees) abort
with the candidates listed.

Examples:
  felt add mocks-unbiased "Are the mocks unbiased?"
  felt add pure_eb/covariance "Covariance method"`,
	Args: cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := resolveProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository (run 'felt init' first)")
		}

		storage := felt.NewStorage(root)

		// Extract [bracketed] tags from slug input (for backward compat)
		extractedTags, cleanSlug := felt.ExtractTags(args[0])

		f, err := felt.New(cleanSlug, args[1])
		if err != nil {
			return err
		}
		if !addTopLevel {
			felts, err := storage.ListMetadata()
			if err != nil {
				return err
			}
			ids := make([]string, len(felts))
			for i, existing := range felts {
				ids[i] = existing.ID
			}
			resolved, rewritten, err := felt.ResolveAddPath(f.ID, ids)
			if err != nil {
				return err
			}
			if rewritten {
				fmt.Fprintf(os.Stderr, "Resolved %s under %s\n", f.ID, resolved)
				f.ID = resolved
			}
		}
		if err := storage.CheckAvailableID(f.ID); err != nil {
			return err
		}

		// Add extracted tags
		for _, tag := range extractedTags {
			f.AddTag(tag)
		}

		if addBody != "" {
			f.Body = addBody
		}
		if addStatus != "" {
			f.Status = addStatus
		}
		if len(addTags) > 0 {
			for _, raw := range addTags {
				for _, tag := range splitTags(raw) {
					f.AddTag(tag)
				}
			}
		}
		if addDue != "" {
			due, err := time.Parse("2006-01-02", addDue)
			if err != nil {
				return fmt.Errorf("invalid due date (use YYYY-MM-DD): %w", err)
			}
			f.Due = &due
		}
		if addOutcome != "" {
			f.Outcome = addOutcome
		}

		if err := storage.Write(f); err != nil {
			return err
		}

		// Record the mechanical event before any subsequent index sync
		// would mistake the new file for an external edit.
		if data, err := os.ReadFile(storage.Path(f.ID)); err == nil {
			recordMechanical(storage, f.ID, felt.EventAdd, []string{"all"}, data)
		}

		fmt.Println(f.ID)
		return nil
	},
}

func init() {
	rootCmd.AddCommand(addCmd)
	addCmd.Flags().StringVarP(&addBody, "body", "b", "", "Body text")
	addCmd.Flags().StringVarP(&addStatus, "status", "s", "", "Status (open, active, closed)")
	addCmd.Flags().StringVarP(&addDue, "due", "D", "", "Due date (YYYY-MM-DD)")
	addCmd.Flags().StringArrayVarP(&addTags, "tag", "t", nil, "Tag (repeatable)")
	addCmd.Flags().StringVarP(&addOutcome, "outcome", "o", "", "Outcome (the conclusion)")
	addCmd.Flags().BoolVar(&addTopLevel, "top-level", false, "Create at the top level; don't resolve <slug> against existing fibers")
}
