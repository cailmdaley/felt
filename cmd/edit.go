package cmd

import (
	"fmt"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

// Edit command flags
var (
	editTitle  string
	editStatus   string
	editDue      string
	editDeps     []string
	editBody     string
	editOutcome  string
)

// Link command flags
var linkLabel string

var editCmd = &cobra.Command{
	Use:   "edit <id>",
	Short: "Modify a felt's properties via flags",
	Long: `Modifies a felt's properties via flags.

Examples:
  felt edit abc123 --title "New title" -s active
  felt edit abc123 --depends-on other-fiber-id
  felt edit abc123 --body "Full replacement body text"  # overwrites body`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := felt.FindProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}

		storage := felt.NewStorage(root)
		f, err := storage.Find(args[0])
		if err != nil {
			return err
		}

		// Check if any modification flags were provided
		hasFlags := cmd.Flags().Changed("title") ||
			cmd.Flags().Changed("status") ||
			cmd.Flags().Changed("due") ||
			cmd.Flags().Changed("depends-on") ||
			cmd.Flags().Changed("body") ||
			cmd.Flags().Changed("outcome")

		if !hasFlags {
			return fmt.Errorf("no changes requested: use edit flags (use --body only when you intend to overwrite the full body)")
		}

		bodyOverwritten := false
		bodyCleared := false

		// Apply flag modifications
		if cmd.Flags().Changed("title") {
			f.Title = editTitle
		}
		if cmd.Flags().Changed("status") {
			switch editStatus {
			case felt.StatusOpen, felt.StatusActive:
				// Reopen if closed
				if f.IsClosed() {
					f.ClosedAt = nil
				}
				f.Status = editStatus
			case felt.StatusClosed:
				if !f.IsClosed() {
					now := time.Now()
					f.Status = felt.StatusClosed
					f.ClosedAt = &now
				}
			case "":
				// Clear status (exit tracking)
				f.Status = ""
				f.ClosedAt = nil
			default:
				return fmt.Errorf("invalid status %q (valid: open, active, closed, or empty to clear)", editStatus)
			}
		}
		if cmd.Flags().Changed("body") {
			if f.Body != "" && editBody != f.Body {
				bodyOverwritten = true
			}
			if f.Body != "" && editBody == "" {
				bodyCleared = true
			}
			f.Body = editBody
		}
		if cmd.Flags().Changed("outcome") {
			f.Outcome = editOutcome
		}
		if cmd.Flags().Changed("due") {
			if editDue == "" {
				f.Due = nil
			} else {
				due, err := time.Parse("2006-01-02", editDue)
				if err != nil {
					return fmt.Errorf("invalid due date (use YYYY-MM-DD): %w", err)
				}
				f.Due = &due
			}
		}
		if cmd.Flags().Changed("depends-on") {
			// Resolve and add dependencies
			for _, dep := range editDeps {
				depFelt, err := storage.Find(dep)
				if err != nil {
					return fmt.Errorf("dependency %q: %w", dep, err)
				}

				// Check if already linked
				if f.DependsOn.HasID(depFelt.ID) {
					continue
				}

				// Add dependency
				f.DependsOn = append(f.DependsOn, felt.Dependency{ID: depFelt.ID})
			}

			// Check for cycles
			felts, err := storage.List()
			if err != nil {
				return err
			}
			g := felt.BuildGraph(felts)
			g.Nodes[f.ID] = f
			g.Upstream[f.ID] = f.DependsOn
			for _, dep := range f.DependsOn {
				if g.DetectCycle(f.ID, dep.ID) {
					return fmt.Errorf("adding dependency would create a cycle")
				}
			}
		}

		if err := storage.Write(f); err != nil {
			return err
		}

		switch {
		case bodyCleared:
			fmt.Printf("Updated %s (body cleared; previous content removed)\n", f.ID)
		case bodyOverwritten:
			fmt.Printf("Updated %s (body overwritten)\n", f.ID)
		default:
			fmt.Printf("Updated %s\n", f.ID)
		}
		return nil
	},
}

var commentCmd = &cobra.Command{
	Use:   "comment <id> <text>",
	Short: "Add a timestamped comment",
	Long:  `Appends a timestamped comment to the felt's body.`,
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := felt.FindProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}

		storage := felt.NewStorage(root)
		f, err := storage.Find(args[0])
		if err != nil {
			return err
		}

		f.AppendComment(args[1])

		if err := storage.Write(f); err != nil {
			return err
		}

		fmt.Printf("Added comment to %s\n", f.ID)
		return nil
	},
}

var linkCmd = &cobra.Command{
	Use:   "link <id> <depends-on-id>",
	Short: "Add a dependency",
	Long:  `Adds a depends-on relationship from the first felt to the second.`,
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := felt.FindProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}

		storage := felt.NewStorage(root)

		f, err := storage.Find(args[0])
		if err != nil {
			return fmt.Errorf("source: %w", err)
		}

		dep, err := storage.Find(args[1])
		if err != nil {
			return fmt.Errorf("dependency: %w", err)
		}

		// Check if already linked
		if f.DependsOn.HasID(dep.ID) {
			return fmt.Errorf("%s already depends on %s", f.ID, dep.ID)
		}

		// Check for cycles
		felts, err := storage.List()
		if err != nil {
			return err
		}

		// Temporarily add the link
		f.DependsOn = append(f.DependsOn, felt.Dependency{ID: dep.ID, Label: linkLabel})
		g := felt.BuildGraph(felts)
		// Update the node in the graph
		g.Nodes[f.ID] = f
		g.Upstream[f.ID] = f.DependsOn

		if g.DetectCycle(f.ID, dep.ID) {
			return fmt.Errorf("adding dependency would create a cycle")
		}

		if err := storage.Write(f); err != nil {
			return err
		}

		if linkLabel != "" {
			fmt.Printf("Linked %s → %s [%s]\n", f.ID, dep.ID, linkLabel)
		} else {
			fmt.Printf("Linked %s → %s\n", f.ID, dep.ID)
		}
		return nil
	},
}

var unlinkCmd = &cobra.Command{
	Use:   "unlink <id> <depends-on-id>",
	Short: "Remove a dependency",
	Long:  `Removes a depends-on relationship.`,
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := felt.FindProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}

		storage := felt.NewStorage(root)

		f, err := storage.Find(args[0])
		if err != nil {
			return fmt.Errorf("source: %w", err)
		}

		dep, err := storage.Find(args[1])
		if err != nil {
			return fmt.Errorf("dependency: %w", err)
		}

		// Find and remove
		found := false
		var newDeps felt.Dependencies
		for _, d := range f.DependsOn {
			if d.ID == dep.ID {
				found = true
			} else {
				newDeps = append(newDeps, d)
			}
		}

		if !found {
			return fmt.Errorf("%s does not depend on %s", f.ID, dep.ID)
		}

		f.DependsOn = newDeps
		if err := storage.Write(f); err != nil {
			return err
		}

		fmt.Printf("Unlinked %s → %s\n", f.ID, dep.ID)
		return nil
	},
}

// find is an alias for "ls -s all <query>" — searches all fibers by default.
var findCmd = &cobra.Command{
	Use:        "find <query>",
	Short:      "Search felts (alias for ls -s all <query>)",
	Long:       `Alias for "felt ls -s all <query>". Searches all fibers regardless of status.`,
	Args:       cobra.ExactArgs(1),
	Deprecated: "use 'felt ls -s all <query>' instead",
	RunE: func(cmd *cobra.Command, args []string) error {
		// Set ls flags to match find's "search everything" behavior
		lsStatus = "all"
		return lsCmd.RunE(lsCmd, args)
	},
}

func init() {
	rootCmd.AddCommand(editCmd)
	rootCmd.AddCommand(commentCmd)
	rootCmd.AddCommand(linkCmd)
	rootCmd.AddCommand(unlinkCmd)
	rootCmd.AddCommand(findCmd)

	// Edit command flags
	editCmd.Flags().StringVarP(&editTitle, "title", "t", "", "Set title")
	editCmd.Flags().StringVarP(&editStatus, "status", "s", "", "Set status (open, active, closed)")
	editCmd.Flags().StringVarP(&editBody, "body", "b", "", "Replace full body text (destructive overwrite)")
	editCmd.Flags().StringVarP(&editOutcome, "outcome", "o", "", "Set outcome")
	editCmd.Flags().StringVarP(&editDue, "due", "D", "", "Set due date (YYYY-MM-DD, empty to clear)")
	editCmd.Flags().StringArrayVarP(&editDeps, "depends-on", "a", nil, "Add dependency (repeatable)")

	// Link command flags
	linkCmd.Flags().StringVarP(&linkLabel, "label", "l", "", "Label explaining the dependency")
}
