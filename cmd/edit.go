package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var (
	findKind   string
	findExact  bool
	findRegex  bool
	findStatus string
	findTags   []string
)

var editCmd = &cobra.Command{
	Use:   "edit <id>",
	Short: "Open a felt in $EDITOR",
	Long:  `Opens the felt's markdown file in your default editor.`,
	Args:  cobra.ExactArgs(1),
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
		for _, d := range f.DependsOn {
			if d == dep.ID {
				return fmt.Errorf("%s already depends on %s", f.ID, dep.ID)
			}
		}

		// Check for cycles
		felts, err := storage.List()
		if err != nil {
			return err
		}

		// Temporarily add the link
		f.DependsOn = append(f.DependsOn, dep.ID)
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

		fmt.Printf("Linked %s → %s\n", f.ID, dep.ID)
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
		var newDeps []string
		for _, d := range f.DependsOn {
			if d == dep.ID {
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
			// Kind filter
			if findKind != "" && f.Kind != findKind {
				continue
			}
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
					re.MatchString(f.CloseReason)
			} else {
				matches = strings.Contains(titleLower, queryLower) ||
					strings.Contains(strings.ToLower(f.Body), queryLower) ||
					strings.Contains(strings.ToLower(f.CloseReason), queryLower)
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
	findCmd.Flags().StringVarP(&findKind, "kind", "k", "", "Filter by kind")
	findCmd.Flags().BoolVarP(&findExact, "exact", "e", false, "Exact title match only")
	findCmd.Flags().BoolVarP(&findRegex, "regex", "r", false, "Treat query as regular expression")
	findCmd.Flags().StringVarP(&findStatus, "status", "s", "", "Filter by status (open, active, closed)")
	findCmd.Flags().StringArrayVarP(&findTags, "tag", "t", nil, "Filter by tag (repeatable, AND logic)")
}
