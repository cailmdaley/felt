package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var findKind string

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
	Long:  `Searches felts by title, body, and close reason.`,
	Args:  cobra.ExactArgs(1),
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

		query := strings.ToLower(args[0])
		var matches []*felt.Felt

		for _, f := range felts {
			// Kind filter
			if findKind != "" && f.Kind != findKind {
				continue
			}
			if strings.Contains(strings.ToLower(f.Title), query) ||
				strings.Contains(strings.ToLower(f.Body), query) ||
				strings.Contains(strings.ToLower(f.CloseReason), query) {
				matches = append(matches, f)
			}
		}

		if jsonOutput {
			return outputJSON(matches)
		}

		if len(matches) == 0 {
			fmt.Printf("No felts matching %q\n", args[0])
			return nil
		}

		for _, f := range matches {
			fmt.Printf("%s %s  %s\n", statusIcon(f.Status), f.ID, f.Title)
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
}
