package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var (
	findExact  bool
	findRegex  bool
	findStatus string
	findTags   []string
)

// Edit command flags
var (
	editPriority int
	editTitle    string
	editDue      string
	editDeps     []string
	editBody     string
	editOutcome  string
)

// Link command flags
var linkLabel string

var editCmd = &cobra.Command{
	Use:   "edit <id>",
	Short: "Modify a felt's properties or open in $EDITOR",
	Long: `Modifies a felt's properties via flags, or opens in $EDITOR if no flags given.

Examples:
  felt edit abc123 --priority 1
  felt edit abc123 --kind decision --title "New title"
  felt edit abc123 --depends-on other-fiber-id
  felt edit abc123                  # opens in $EDITOR`,
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
		hasFlags := cmd.Flags().Changed("priority") ||
			cmd.Flags().Changed("title") ||
			cmd.Flags().Changed("due") ||
			cmd.Flags().Changed("depends-on") ||
			cmd.Flags().Changed("body") ||
			cmd.Flags().Changed("outcome")

		if !hasFlags {
			// No flags: open in editor
			editor := os.Getenv("EDITOR")
			if editor == "" {
				editor = "vim"
			}

			path := storage.Path(f.ID)
			editorCmd := exec.Command(editor, path)
			editorCmd.Stdin = os.Stdin
			editorCmd.Stdout = os.Stdout
			editorCmd.Stderr = os.Stderr

			return editorCmd.Run()
		}

		// Apply flag modifications
		if cmd.Flags().Changed("priority") {
			f.Priority = editPriority
		}
		if cmd.Flags().Changed("title") {
			f.Title = editTitle
		}
		if cmd.Flags().Changed("body") {
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

		fmt.Printf("Updated %s\n", f.ID)
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

var findCmd = &cobra.Command{
	Use:   "find <query>",
	Short: "Search felts",
	Long: `Searches felts by title, body, and close reason.

Flags:
  --exact/-e    Only match felts where title equals query exactly
  --regex/-r    Treat query as a regular expression

Results are sorted with exact title matches first.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := felt.FindProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}

		storage := felt.NewStorage(root)
		felts, err := storage.List()
		if err != nil {
			return err
		}

		query := args[0]
		queryLower := strings.ToLower(query)

		// Compile regex if needed
		var re *regexp.Regexp
		if findRegex {
			var err error
			re, err = regexp.Compile("(?i)" + query) // case-insensitive
			if err != nil {
				return fmt.Errorf("invalid regex: %w", err)
			}
		}

		var exactMatches []*felt.Felt
		var partialMatches []*felt.Felt

		for _, f := range felts {
			// Status filter
			if findStatus != "" && f.Status != findStatus {
				continue
			}
			// Tag filter (AND logic)
			if len(findTags) > 0 {
				hasAll := true
				for _, tag := range findTags {
					if !f.HasTag(tag) {
						hasAll = false
						break
					}
				}
				if !hasAll {
					continue
				}
			}

			titleLower := strings.ToLower(f.Title)

			// Check for exact title match (not applicable in regex mode)
			if !findRegex && titleLower == queryLower {
				exactMatches = append(exactMatches, f)
				continue
			}

			// If --exact flag, skip partial matches
			if findExact {
				continue
			}

			// Check for matches (regex or substring)
			var matches bool
			if findRegex {
				matches = re.MatchString(f.Title) ||
					re.MatchString(f.Body) ||
					re.MatchString(f.Outcome)
			} else {
				matches = strings.Contains(titleLower, queryLower) ||
					strings.Contains(strings.ToLower(f.Body), queryLower) ||
					strings.Contains(strings.ToLower(f.Outcome), queryLower)
			}

			if matches {
				partialMatches = append(partialMatches, f)
			}
		}

		// Combine: exact matches first, then partial
		allMatches := append(exactMatches, partialMatches...)

		if jsonOutput {
			return outputJSON(allMatches)
		}

		if len(allMatches) == 0 {
			fmt.Printf("No felts matching %q\n", query)
			return nil
		}

		for _, f := range allMatches {
			printFeltTwoLine(f)
		}

		return nil
	},
}

func init() {
	rootCmd.AddCommand(editCmd)
	rootCmd.AddCommand(commentCmd)
	rootCmd.AddCommand(linkCmd)
	rootCmd.AddCommand(unlinkCmd)
	rootCmd.AddCommand(findCmd)

	// Edit command flags
	editCmd.Flags().IntVarP(&editPriority, "priority", "p", 2, "Set priority (0-4, lower=more urgent)")
	editCmd.Flags().StringVarP(&editTitle, "title", "t", "", "Set title")
	editCmd.Flags().StringVarP(&editBody, "body", "b", "", "Set body text")
	editCmd.Flags().StringVarP(&editOutcome, "outcome", "o", "", "Set outcome")
	editCmd.Flags().StringVarP(&editDue, "due", "D", "", "Set due date (YYYY-MM-DD, empty to clear)")
	editCmd.Flags().StringArrayVarP(&editDeps, "depends-on", "a", nil, "Add dependency (repeatable)")

	// Link command flags
	linkCmd.Flags().StringVarP(&linkLabel, "label", "l", "", "Label explaining the dependency")

	// Find command flags
	findCmd.Flags().BoolVarP(&findExact, "exact", "e", false, "Exact title match only")
	findCmd.Flags().BoolVarP(&findRegex, "regex", "r", false, "Treat query as regular expression")
	findCmd.Flags().StringVarP(&findStatus, "status", "s", "", "Filter by status (open, active, closed)")
	findCmd.Flags().StringArrayVarP(&findTags, "tag", "t", nil, "Filter by tag (repeatable, AND logic)")
}
