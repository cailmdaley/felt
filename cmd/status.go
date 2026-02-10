package cmd

import (
	"fmt"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var offOutcome string

var onCmd = &cobra.Command{
	Use:   "on <id>",
	Short: "Mark a felt as active",
	Long:  `Marks a fiber as active (enters tracking if fiber had no status). Reopens if closed.`,
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

		wasClosed := f.IsClosed()
		f.Status = felt.StatusActive
		// Clear closure metadata when reopening
		if wasClosed {
			f.ClosedAt = nil
			f.Outcome = ""
		}
		if err := storage.Write(f); err != nil {
			return err
		}

		fmt.Printf("◐ %s  %s\n", f.ID, f.Title)
		return nil
	},
}

var offCmd = &cobra.Command{
	Use:   "off <id>",
	Short: "Close a felt or set its outcome",
	Long: `Sets the outcome and/or closes a fiber.
If the fiber has a status, it is closed. If -r is provided, the outcome is set.
A fiber without status and without -r has nothing to do.`,
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

		// Update outcome if provided
		if offOutcome != "" {
			f.Outcome = offOutcome
		}

		// Close if fiber has a status
		if f.HasStatus() {
			if !f.IsClosed() {
				now := time.Now()
				f.Status = felt.StatusClosed
				f.ClosedAt = &now
			}
		} else if offOutcome == "" {
			return fmt.Errorf("fiber has no status to close; use -r to set an outcome")
		}

		if err := storage.Write(f); err != nil {
			return err
		}

		if f.HasStatus() {
			fmt.Printf("● %s  %s\n", f.ID, f.Title)
		} else {
			fmt.Printf("  %s  %s\n", f.ID, f.Title)
		}
		return nil
	},
}

var rmCmd = &cobra.Command{
	Use:   "rm <id>",
	Short: "Delete a felt",
	Long:  `Permanently removes a felt from the repository.`,
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

		// Check if anything depends on this
		felts, err := storage.List()
		if err != nil {
			return err
		}
		for _, other := range felts {
			if other.DependsOn.HasID(f.ID) {
				return fmt.Errorf("cannot delete: %s depends on this felt", other.ID)
			}
		}

		if err := storage.Delete(f.ID); err != nil {
			return err
		}

		fmt.Printf("Deleted %s\n", f.ID)
		return nil
	},
}

func init() {
	rootCmd.AddCommand(onCmd)
	rootCmd.AddCommand(offCmd)
	rootCmd.AddCommand(rmCmd)

	offCmd.Flags().StringVarP(&offOutcome, "outcome", "o", "", "Outcome (the conclusion)")
}
