package cmd

import (
	"fmt"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var offReason string

var onCmd = &cobra.Command{
	Use:   "on <id>",
	Short: "Mark a felt as active",
	Long:  `Marks a fiber as active. Reopens if closed.`,
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
			f.CloseReason = ""
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
	Short: "Mark a felt as closed",
	Long:  `Marks a felt as completed/closed with an optional reason.`,
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

		// If already closed, update reason if provided, otherwise no-op
		if f.IsClosed() {
			if offReason != "" {
				f.CloseReason = offReason
				if err := storage.Write(f); err != nil {
					return err
				}
			}
			fmt.Printf("● %s  %s\n", f.ID, f.Title)
			return nil
		}

		now := time.Now()
		f.Status = felt.StatusClosed
		f.ClosedAt = &now
		if offReason != "" {
			f.CloseReason = offReason
		}

		if err := storage.Write(f); err != nil {
			return err
		}

		fmt.Printf("● %s  %s\n", f.ID, f.Title)
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

	offCmd.Flags().StringVarP(&offReason, "reason", "r", "", "Reason for closing")
}
