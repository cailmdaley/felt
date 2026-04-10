package cmd

import (
	"fmt"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var retiredCommandNames = map[string]struct{}{
	"check":      {},
	"comment":    {},
	"downstream": {},
	"find":       {},
	"graph":      {},
	"link":       {},
	"path":       {},
	"prime":      {},
	"ready":      {},
	"tag":        {},
	"tapestry":   {},
	"unlink":     {},
	"untag":      {},
	"upstream":   {},
}

var (
	addBody    string
	addStatus  string
	addDue     string
	addTags    []string
	addOutcome string
)

var addCmd = &cobra.Command{
	Use:   "add <slug> <name>",
	Short: "Create a new felt",
	Long: `Creates a new felt with the given slug and name.

The slug is the fiber's path/ID shorthand. The name is the first real content
and is required explicitly.

Examples:
  felt add mocks-unbiased "Are the mocks unbiased?"
  felt add pure_eb/covariance "Covariance method"
  felt mocks-unbiased "Are the mocks unbiased?" -t pure-eb`,
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
}

// Also allow bare "felt <slug> <name>" as shorthand for "felt add <slug> <name>".
func init() {
	rootCmd.Args = cobra.ArbitraryArgs

	// Copy add command flags to root so "felt <slug> <name> ..." works
	rootCmd.Flags().StringVarP(&addBody, "body", "b", "", "Body text")
	rootCmd.Flags().StringVarP(&addStatus, "status", "s", "", "Status (open, active, closed)")
	rootCmd.Flags().StringVarP(&addDue, "due", "D", "", "Due date (YYYY-MM-DD)")
	rootCmd.Flags().StringArrayVarP(&addTags, "tag", "t", nil, "Tag (repeatable)")
	rootCmd.Flags().StringVarP(&addOutcome, "outcome", "o", "", "Outcome (the conclusion)")

	originalRun := rootCmd.RunE
	rootCmd.RunE = func(cmd *cobra.Command, args []string) error {
		if len(args) > 0 && isRetiredCommand(args[0]) {
			return fmt.Errorf("unknown command %q for %q", args[0], cmd.CommandPath())
		}
		if len(args) == 2 && !isSubcommand(args[0]) {
			return addCmd.RunE(cmd, args)
		}
		if originalRun != nil {
			return originalRun(cmd, args)
		}
		return cmd.Help()
	}
}

func isRetiredCommand(name string) bool {
	_, ok := retiredCommandNames[name]
	return ok
}

func isSubcommand(name string) bool {
	for _, cmd := range rootCmd.Commands() {
		if cmd.Name() == name {
			return true
		}
		for _, alias := range cmd.Aliases {
			if alias == name {
				return true
			}
		}
	}
	return false
}
