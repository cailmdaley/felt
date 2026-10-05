package feltcli

import (
	"fmt"
	"os"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/sysenv"
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
	Short: "Create a fiber",
	Long: `Creates .felt/<slug>/<basename>.md and prints the new id. <name> is the
display name; the fiber has no status unless -s gives it one.

When <slug>'s parent path exists (a fiber, or a directory of fibers such as
roles/), the fiber lands exactly there. Otherwise a leading segment that is an
existing fiber's basename places <slug> under that fiber's parent: with
project/launch in the store, launch/log becomes project/launch/log (reported
on stderr). An ambiguous match aborts with the candidates; --top-level skips
resolution and uses <slug> as spelled.`,
	Example: `  felt add analysis/covariance "Covariance method" -s open
  felt add analysis/jackknife-bias "Jackknife bias" -o "negligible below 200 patches"`,
	Args: cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := felt.ProjectRoot(sysenv.OS(), changeDir)
		if err != nil {
			return fmt.Errorf("not in a felt repository (run 'felt init' first)")
		}

		storage := felt.NewStorage(root)

		// Pull [bracketed] tags out of the slug so `felt add "[tag]name"` works
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
		if err := f.SetStatus(addStatus, f.CreatedAt); err != nil {
			return err
		}
		for _, tag := range splitListFlag(addTags) {
			f.AddTag(tag)
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

		// Seed the durable recency anchor at creation time, so a fresh clone
		// orders a never-edited fiber by when it was born, not file mtime.
		f.Touch(f.CreatedAt)

		if err := storage.Write(f); err != nil {
			return err
		}

		fmt.Println(f.ID)
		return nil
	},
}

func init() {
	addCmd.GroupID = groupFibers
	rootCmd.AddCommand(addCmd)
	addCmd.Flags().StringVarP(&addBody, "body", "b", "", "Body text")
	addCmd.Flags().StringVarP(&addStatus, "status", "s", "", "Status (open, active, closed)")
	addCmd.Flags().StringVarP(&addDue, "due", "D", "", "Due date (YYYY-MM-DD)")
	addCmd.Flags().StringArrayVarP(&addTags, "tag", "t", nil, "Tag (repeatable or comma-separated)")
	addCmd.Flags().StringVarP(&addOutcome, "outcome", "o", "", "Outcome: what was decided or learned")
	addCmd.Flags().BoolVar(&addTopLevel, "top-level", false, "Use <slug> as spelled; don't resolve it against existing fibers")
}
