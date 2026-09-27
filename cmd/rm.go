package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var rmCmd = &cobra.Command{
	Use:   "rm <id>",
	Short: "Delete a fiber",
	Long: `Deletes the fiber's file. Nested fibers are not removed: they keep their ids
under a directory that no longer has a fiber of its own. Links to the deleted
fiber are left broken; felt check reports them.`,
	Example: `  felt show analysis/scratch --citations   # the fibers whose links would break
  felt rm analysis/scratch`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		storage, root, err := requireStore()
		if err != nil {
			return err
		}
		scopeID := resolveCommandScope(root)

		// An id that names a fiber in the enclosing store is deleted there,
		// and the output says where — a cross-store deletion is never silent.
		target, err := resolveFiberRef(storage, scopeID, args[0])
		if err != nil {
			return err
		}

		if err := target.storage.Delete(target.id); err != nil {
			return err
		}

		// Deletion records nothing: every read walks the markdown tree, so a
		// removed fiber is observable as absence. Git history of .felt/
		// captures the deletion if archaeology is needed.

		fmt.Printf("Deleted %s%s\n", target.id, target.location())
		return nil
	},
}

func init() {
	rmCmd.GroupID = groupFibers
	rootCmd.AddCommand(rmCmd)
}
