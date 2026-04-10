package cmd

import (
	"fmt"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

// Edit command flags
var (
	editName    string
	editStatus  string
	editDue     string
	editTags    []string
	editUntag   []string
	editComment []string
	editBody    string
	editOutcome string
)

var editCmd = &cobra.Command{
	Use:   "edit <id>",
	Short: "Modify a felt's properties via flags",
	Long: `Modifies a felt's properties via flags.

Examples:
  felt edit abc123 --name "New name" -s active
  felt edit abc123 --tag decision --untag stale
  felt edit abc123 --comment "latest finding"
  felt edit abc123 --body "Full replacement body text"  # overwrites body`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := resolveProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}

		storage := felt.NewStorage(root)
		scopeID := resolveCommandScope(root)
		target, err := storage.FindMetadataInScope(scopeID, args[0])
		if err != nil {
			return err
		}
		f, err := storage.Read(target.ID)
		if err != nil {
			return err
		}

		// Check if any modification flags were provided
		hasFlags := cmd.Flags().Changed("name") ||
			cmd.Flags().Changed("status") ||
			cmd.Flags().Changed("due") ||
			cmd.Flags().Changed("tag") ||
			cmd.Flags().Changed("untag") ||
			cmd.Flags().Changed("comment") ||
			cmd.Flags().Changed("body") ||
			cmd.Flags().Changed("outcome")

		if !hasFlags {
			return fmt.Errorf("no changes requested: use edit flags (use --body only when you intend to overwrite the full body)")
		}

		bodyOverwritten := false
		bodyCleared := false

		// Apply flag modifications
		if cmd.Flags().Changed("name") {
			f.Name = editName
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
			if f.Body != "" && editBody != f.Body && !f.HasScaffoldOnlyBody() {
				bodyOverwritten = true
			}
			if f.Body != "" && editBody == "" && !f.HasScaffoldOnlyBody() {
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
	editCmd.Flags().StringVar(&editName, "name", "", "Set name")
	editCmd.Flags().StringVarP(&editStatus, "status", "s", "", "Set status (open, active, closed)")
	editCmd.Flags().StringArrayVarP(&editTags, "tag", "t", nil, "Add tag(s) (repeatable; comma-separated accepted)")
	editCmd.Flags().StringArrayVar(&editUntag, "untag", nil, "Remove tag(s)")
	editCmd.Flags().StringArrayVarP(&editComment, "comment", "c", nil, "Append comment text to the body (repeatable)")
	editCmd.Flags().StringVarP(&editBody, "body", "b", "", "Replace full body text (destructive overwrite)")
	editCmd.Flags().StringVarP(&editOutcome, "outcome", "o", "", "Set outcome")
	editCmd.Flags().StringVarP(&editDue, "due", "D", "", "Set due date (YYYY-MM-DD, empty to clear)")
}

// splitTags splits comma-separated tag input into individual tags.
// "claim, tapestry:foo" -> ["claim", "tapestry:foo"]
