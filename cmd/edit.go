package cmd

import (
	"fmt"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

// Edit command flags
var (
	editTitle   string
	editStatus  string
	editDue     string
	editDeps    []string
	editTags    []string
	editUntag   []string
	editLink    []string
	editUnlink  []string
	editComment []string
	editBody    string
	editOutcome string
)

// Link command flags
var linkLabel string

var editCmd = &cobra.Command{
	Use:   "edit <id>",
	Short: "Modify a felt's properties via flags",
	Long: `Modifies a felt's properties via flags.

Examples:
  felt edit abc123 --title "New title" -s active
  felt edit abc123 --tag decision --untag stale
  felt edit abc123 --link other-fiber-id --label "why this depends on it"
  felt edit abc123 --comment "latest finding"
  felt edit abc123 --body "Full replacement body text"  # overwrites body`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := felt.FindProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}

		storage := felt.NewStorage(root)
		target, err := storage.FindMetadata(args[0])
		if err != nil {
			return err
		}
		f, err := storage.Read(target.ID)
		if err != nil {
			return err
		}

		// Check if any modification flags were provided
		hasFlags := cmd.Flags().Changed("title") ||
			cmd.Flags().Changed("status") ||
			cmd.Flags().Changed("due") ||
			cmd.Flags().Changed("depends-on") ||
			cmd.Flags().Changed("tag") ||
			cmd.Flags().Changed("untag") ||
			cmd.Flags().Changed("link") ||
			cmd.Flags().Changed("unlink") ||
			cmd.Flags().Changed("comment") ||
			cmd.Flags().Changed("label") ||
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
		if cmd.Flags().Changed("tag") {
			for _, raw := range editTags {
				for _, tag := range splitTags(raw) {
					f.AddTag(tag)
				}
			}
		}
		if cmd.Flags().Changed("untag") {
			for _, raw := range editUntag {
				for _, tag := range splitTags(raw) {
					f.RemoveTag(tag)
				}
			}
		}
		if cmd.Flags().Changed("comment") {
			for _, comment := range editComment {
				f.AppendComment(comment)
			}
		}
		if cmd.Flags().Changed("depends-on") || cmd.Flags().Changed("link") || cmd.Flags().Changed("unlink") || cmd.Flags().Changed("label") {
			felts, err := storage.ListMetadata()
			if err != nil {
				return err
			}

			// Resolve and add dependencies
			for _, dep := range editDeps {
				depFelt, err := felt.FindByPrefix(felts, dep)
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

			if linkLabel != "" && len(editLink) != 1 {
				return fmt.Errorf("--label requires exactly one --link target")
			}

			for _, dep := range editLink {
				depFelt, err := felt.FindByPrefix(felts, dep)
				if err != nil {
					return fmt.Errorf("dependency %q: %w", dep, err)
				}
				if f.DependsOn.HasID(depFelt.ID) {
					continue
				}
				label := ""
				if len(editLink) == 1 {
					label = linkLabel
				}
				f.DependsOn = append(f.DependsOn, felt.Dependency{ID: depFelt.ID, Label: label})
			}

			for _, dep := range editUnlink {
				depFelt, err := felt.FindByPrefix(felts, dep)
				if err != nil {
					return fmt.Errorf("dependency %q: %w", dep, err)
				}

				var newDeps felt.Dependencies
				for _, d := range f.DependsOn {
					if d.ID != depFelt.ID {
						newDeps = append(newDeps, d)
					}
				}
				f.DependsOn = newDeps
			}

			// Check for cycles
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

func init() {
	rootCmd.AddCommand(editCmd)

	// Edit command flags
	editCmd.Flags().StringVarP(&editTitle, "title", "t", "", "Set title")
	editCmd.Flags().StringVarP(&editStatus, "status", "s", "", "Set status (open, active, closed)")
	editCmd.Flags().StringArrayVar(&editTags, "tag", nil, "Add tag(s) (repeatable; comma-separated accepted)")
	editCmd.Flags().StringArrayVar(&editUntag, "untag", nil, "Remove tag(s) (repeatable; comma-separated accepted)")
	editCmd.Flags().StringArrayVar(&editLink, "link", nil, "Add dependency (repeatable)")
	editCmd.Flags().StringArrayVar(&editUnlink, "unlink", nil, "Remove dependency (repeatable)")
	editCmd.Flags().StringArrayVar(&editComment, "comment", nil, "Append comment text to the body (repeatable)")
	editCmd.Flags().StringVarP(&linkLabel, "label", "l", "", "Label for a single --link dependency")
	editCmd.Flags().StringVarP(&editBody, "body", "b", "", "Replace full body text (destructive overwrite)")
	editCmd.Flags().StringVarP(&editOutcome, "outcome", "o", "", "Set outcome")
	editCmd.Flags().StringVarP(&editDue, "due", "D", "", "Set due date (YYYY-MM-DD, empty to clear)")
	editCmd.Flags().StringArrayVarP(&editDeps, "depends-on", "a", nil, "Add dependency (repeatable)")
}

// splitTags splits comma-separated tag input into individual tags.
// "claim, tapestry:foo" -> ["claim", "tapestry:foo"]
func splitTags(input string) []string {
	parts := strings.Split(input, ",")
	var tags []string
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			tags = append(tags, p)
		}
	}
	return tags
}
