package feltcli

import (
	"fmt"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var rmCmd = &cobra.Command{
	Use:   "rm <id>",
	Short: "Delete a fiber",
	Long: `Deletes the fiber's file. Nested fibers are not removed: they keep their ids
under a directory that no longer has a fiber of its own. Links to the deleted
fiber are left broken; felt check reports them.

rm never acts on a guess. An id that resolves only by its last segment or as a
prefix completion is refused, naming the fiber it would have reached; exact
ids, scope-relative paths, unique bare slugs, and correct partial paths are
not guesses.`,
	Example: `  felt show analysis/scratch --citations   # the fibers whose links would break
  felt rm analysis/scratch`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		storage, root, err := felt.RequireStore(changeDir)
		if err != nil {
			return err
		}
		scopeID := felt.CommandScope(root, changeDir)

		// An id that names a fiber in the enclosing store is deleted there,
		// and the output says where — a cross-store deletion is never silent.
		target, err := felt.ResolveExactRef(storage, scopeID, args[0])
		if err != nil {
			return err
		}

		if err := target.Storage.Delete(target.ID); err != nil {
			return err
		}

		// Deletion records nothing: every read walks the markdown tree, so a
		// removed fiber is observable as absence. Git history of .felt/
		// captures the deletion if archaeology is needed.

		fmt.Printf("Deleted %s%s\n", target.ID, target.Location())
		return nil
	},
}

func init() {
	rmCmd.GroupID = groupFibers
	rootCmd.AddCommand(rmCmd)
}
