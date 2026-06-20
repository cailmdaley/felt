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
		root, err := resolveProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}

		storage := felt.NewStorage(root)
		scopeID := resolveCommandScope(root)
		felts, err := storage.ListMetadata()
		if err != nil {
			return err
		}

		f, err := felt.FindByScope(felts, scopeID, args[0])
		if err != nil {
			return err
		}

		if err := storage.Delete(f.ID); err != nil {
			return err
		}

		// Deletion records nothing: the index rebuilds from disk, so a
		// removed fiber is observable as absence. Git history of .felt/
		// captures the deletion if archaeology is needed.

		fmt.Printf("Deleted %s\n", f.ID)
		return nil
	},
}

func init() {
	rootCmd.AddCommand(rmCmd)
}
