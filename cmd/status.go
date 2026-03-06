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
		felts, err := storage.ListMetadata()
		if err != nil {
			return err
		}

		f, err := felt.FindByPrefix(felts, args[0])
		if err != nil {
			return err
		}

		force, _ := cmd.Flags().GetBool("force")
		for _, other := range felts {
			if other.DependsOn.HasID(f.ID) {
				if !force {
					return fmt.Errorf("cannot delete: %s depends on this felt", other.ID)
				}
				fullOther, err := storage.Read(other.ID)
				if err != nil {
					return fmt.Errorf("reading %s: %w", other.ID, err)
				}
				// Auto-unlink
				var newDeps felt.Dependencies
				for _, d := range fullOther.DependsOn {
					if d.ID != f.ID {
						newDeps = append(newDeps, d)
					}
				}
				fullOther.DependsOn = newDeps
				if err := storage.Write(fullOther); err != nil {
					return fmt.Errorf("unlinking %s: %w", other.ID, err)
				}
				fmt.Printf("Unlinked %s → %s\n", other.ID, f.ID)
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
	rmCmd.Flags().BoolP("force", "f", false, "Auto-unlink dependents before deleting")
}
