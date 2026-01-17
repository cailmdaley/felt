package cmd

import (
	"fmt"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var (
	addBody     string
	addKind     string
	addPriority int
	addDeps     []string
	addDue      string
	addTags     []string
	addReason   string
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

		// Apply flags
		if addBody != "" {
			f.Body = addBody
		}
		if addKind != "" {
			f.Kind = addKind
		}
		if cmd.Flags().Changed("priority") {
			f.Priority = addPriority
		}
		if len(addTags) > 0 {
			for _, tag := range addTags {
				f.AddTag(tag)
			}
		}
		if len(addDeps) > 0 {
			// Resolve dependency IDs
			for _, dep := range addDeps {
				depFelt, err := storage.Find(dep)
				if err != nil {
					return fmt.Errorf("dependency %q: %w", dep, err)
				}
				f.DependsOn = append(f.DependsOn, depFelt.ID)
			}

			// Check for cycles
			felts, err := storage.List()
			if err != nil {
				return err
			}
			// Add the new felt temporarily for cycle check
			felts = append(felts, f)
			g := felt.BuildGraph(felts)
			for _, depID := range f.DependsOn {
				if g.DetectCycle(f.ID, depID) {
					return fmt.Errorf("adding dependency on %s would create a cycle", depID)
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
		if addReason != "" {
			f.Status = felt.StatusClosed
			now := time.Now()
			f.ClosedAt = &now
			f.CloseReason = addReason
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
	addCmd.Flags().StringVarP(&addKind, "kind", "k", "", "Kind (task, spec, thread, etc)")
	addCmd.Flags().IntVarP(&addPriority, "priority", "p", 2, "Priority (0-4, lower=more urgent)")
	addCmd.Flags().StringArrayVarP(&addDeps, "depends-on", "a", nil, "Dependency ID (repeatable)")
	addCmd.Flags().StringVarP(&addDue, "due", "D", "", "Due date (YYYY-MM-DD)")
	addCmd.Flags().StringArrayVarP(&addTags, "tag", "t", nil, "Tag (repeatable)")
	addCmd.Flags().StringVarP(&addReason, "reason", "r", "", "Close reason (creates fiber already closed)")
}

// Also allow bare "felt <title>" as shorthand for "felt add <title>"
func init() {
	rootCmd.Args = cobra.ArbitraryArgs

	// Copy add command flags to root so "felt <title> -a dep" works
	rootCmd.Flags().StringVarP(&addBody, "body", "b", "", "Body text")
	rootCmd.Flags().StringVarP(&addKind, "kind", "k", "", "Kind (task, spec, thread, etc)")
	rootCmd.Flags().IntVarP(&addPriority, "priority", "p", 2, "Priority (0-4, lower=more urgent)")
	rootCmd.Flags().StringArrayVarP(&addDeps, "depends-on", "a", nil, "Dependency ID (repeatable)")
	rootCmd.Flags().StringVarP(&addDue, "due", "D", "", "Due date (YYYY-MM-DD)")
	rootCmd.Flags().StringArrayVarP(&addTags, "tag", "t", nil, "Tag (repeatable)")
	rootCmd.Flags().StringVarP(&addReason, "reason", "r", "", "Close reason (creates fiber already closed)")

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
