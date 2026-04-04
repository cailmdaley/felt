package cmd

import (
	"fmt"
	"path"
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
	addDeps    []string
	addDue     string
	addTags    []string
	addOutcome string
	addTitle   string
	addIn      string
)

var addCmd = &cobra.Command{
	Use:   "add <slug>",
	Short: "Create a new felt",
	Long: `Creates a new felt with the given slug and optional title.

The slug is the short DAG node label and the fiber's ID.
If --title is not provided, the title is derived from the slug.

Examples:
  felt add mocks-unbiased --title "Are the mocks unbiased?"
  felt add mocks-unbiased                  # title → "Mocks unbiased"
  felt mocks-unbiased -t pure-eb           # shorthand + tag`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := resolveProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository (run 'felt init' first)")
		}

		storage := felt.NewStorage(root)

		// Extract [bracketed] tags from slug input (for backward compat)
		extractedTags, cleanSlug := felt.ExtractTags(args[0])

		f, err := felt.New(cleanSlug, addTitle)
		if err != nil {
			return err
		}
		if addIn != "" {
			felts, err := storage.ListMetadata()
			if err != nil {
				return err
			}
			parent, err := felt.FindByPrefix(felts, addIn)
			if err != nil {
				return fmt.Errorf("--in %q: %w", addIn, err)
			}
			f.ID = path.Join(parent.ID, f.ID)
		}
		f.ID, err = storage.NextAvailableID(f.ID)
		if err != nil {
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
		if len(addDeps) > 0 {
			felts, err := storage.ListMetadata()
			if err != nil {
				return err
			}

			// Resolve dependency IDs
			for _, dep := range addDeps {
				depFelt, err := felt.FindByPrefix(felts, dep)
				if err != nil {
					return fmt.Errorf("dependency %q: %w", dep, err)
				}
				f.DependsOn = append(f.DependsOn, felt.NewDependency(depFelt.ID, ""))
			}

			// Check for cycles
			// Add the new felt temporarily for cycle check
			felts = append(felts, f)
			g := felt.BuildGraph(felts)
			for _, dep := range f.DependsOn {
				if g.DetectCycle(f.ID, dep.ID) {
					return fmt.Errorf("adding dependency on %s would create a cycle", dep.ID)
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
	addCmd.Flags().StringVar(&addTitle, "title", "", "Title (if omitted, derived from slug)")
	addCmd.Flags().StringVarP(&addBody, "body", "b", "", "Body text")
	addCmd.Flags().StringVarP(&addStatus, "status", "s", "", "Status (open, active, closed)")
	addCmd.Flags().StringArrayVarP(&addDeps, "depends-on", "a", nil, "Dependency ID (repeatable)")
	addCmd.Flags().StringVarP(&addDue, "due", "D", "", "Due date (YYYY-MM-DD)")
	addCmd.Flags().StringArrayVarP(&addTags, "tag", "t", nil, "Tag (repeatable)")
	addCmd.Flags().StringVarP(&addOutcome, "outcome", "o", "", "Outcome (the conclusion)")
	addCmd.Flags().StringVarP(&addIn, "in", "i", "", "Parent fiber ID: new fiber ID is prefixed with parent's ID")
}

// Also allow bare "felt <title>" as shorthand for "felt add <title>"
func init() {
	rootCmd.Args = cobra.ArbitraryArgs

	// Copy add command flags to root so "felt <slug> --title ..." works
	rootCmd.Flags().StringVar(&addTitle, "title", "", "Title (if omitted, derived from slug)")
	rootCmd.Flags().StringVarP(&addBody, "body", "b", "", "Body text")
	rootCmd.Flags().StringVarP(&addStatus, "status", "s", "", "Status (open, active, closed)")
	rootCmd.Flags().StringArrayVarP(&addDeps, "depends-on", "a", nil, "Dependency ID (repeatable)")
	rootCmd.Flags().StringVarP(&addDue, "due", "D", "", "Due date (YYYY-MM-DD)")
	rootCmd.Flags().StringArrayVarP(&addTags, "tag", "t", nil, "Tag (repeatable)")
	rootCmd.Flags().StringVarP(&addOutcome, "outcome", "o", "", "Outcome (the conclusion)")
	rootCmd.Flags().StringVarP(&addIn, "in", "i", "", "Parent fiber ID: new fiber ID is prefixed with parent's ID")

	originalRun := rootCmd.RunE
	rootCmd.RunE = func(cmd *cobra.Command, args []string) error {
		if len(args) > 0 && isRetiredCommand(args[0]) {
			return fmt.Errorf("unknown command %q for %q", args[0], cmd.CommandPath())
		}
		if len(args) == 1 && !isSubcommand(args[0]) {
			// Treat as "felt add <title>"
			// Flags are already parsed into the add* variables since we share them
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
