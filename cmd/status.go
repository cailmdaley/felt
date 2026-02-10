package cmd

import (
	"fmt"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

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
	rootCmd.AddCommand(rmCmd)
}
