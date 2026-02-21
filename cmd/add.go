package cmd

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var (
	addBody   string
	addStatus string
	addDeps   []string
	addDue      string
	addTags     []string
	addOutcome  string
)

var addCmd = &cobra.Command{
	Use:   "add <title>",
	Short: "Create a new felt",
	Long:  `Creates a new felt with the given title and optional flags.`,
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := felt.FindProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository (run 'felt init' first)")
		}

		storage := felt.NewStorage(root)

		// Extract [bracketed] tags from title
		extractedTags, cleanTitle := felt.ExtractTags(args[0])

		f, err := felt.New(cleanTitle)
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
			// Resolve dependency IDs
			for _, dep := range addDeps {
				depFelt, err := storage.Find(dep)
				if err != nil {
					return fmt.Errorf("dependency %q: %w", dep, err)
				}
				f.DependsOn = append(f.DependsOn, felt.Dependency{ID: depFelt.ID})
			}

			// Check for cycles
			felts, err := storage.List()
			if err != nil {
				return err
			}
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

		// Warn if title is long — titles render as DAG node labels (2-3 words ideal)
		if len(strings.Fields(f.Title)) > 5 {
			fmt.Fprintf(os.Stderr, "warning: title %q is long (%d words); titles render as DAG node labels — keep to 2-3 words, put detail in body/outcome\n",
				f.Title, len(strings.Fields(f.Title)))
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
	addCmd.Flags().StringArrayVarP(&addDeps, "depends-on", "a", nil, "Dependency ID (repeatable)")
	addCmd.Flags().StringVarP(&addDue, "due", "D", "", "Due date (YYYY-MM-DD)")
	addCmd.Flags().StringArrayVarP(&addTags, "tag", "t", nil, "Tag (repeatable)")
	addCmd.Flags().StringVarP(&addOutcome, "outcome", "o", "", "Outcome (the conclusion)")
}

// Also allow bare "felt <title>" as shorthand for "felt add <title>"
func init() {
	rootCmd.Args = cobra.ArbitraryArgs

	// Copy add command flags to root so "felt <title> -a dep" works
	rootCmd.Flags().StringVarP(&addBody, "body", "b", "", "Body text")
	rootCmd.Flags().StringVarP(&addStatus, "status", "s", "", "Status (open, active, closed)")
	rootCmd.Flags().StringArrayVarP(&addDeps, "depends-on", "a", nil, "Dependency ID (repeatable)")
	rootCmd.Flags().StringVarP(&addDue, "due", "D", "", "Due date (YYYY-MM-DD)")
	rootCmd.Flags().StringArrayVarP(&addTags, "tag", "t", nil, "Tag (repeatable)")
	rootCmd.Flags().StringVarP(&addOutcome, "outcome", "o", "", "Outcome (the conclusion)")

	originalRun := rootCmd.RunE
	rootCmd.RunE = func(cmd *cobra.Command, args []string) error {
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
