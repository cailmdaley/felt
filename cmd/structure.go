package cmd

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var (
	migrateDir        string
	migrateDryRun     bool
	backfillIDsDir    string
	backfillIDsDryRun bool
)

var migrateCmd = &cobra.Command{
	Use:   "migrate",
	Short: "Convert legacy store layouts to the current model",
	Long: `Converts legacy storage in place:
  - two or more bare .felt/*.md files become <slug>/<slug>.md fibers, and
    inputs.from references to their old ids are rewritten (a single bare .md
    is the store's entry-point fiber and stays)
  - frontmatter title becomes name
  - inert depends-on frontmatter is removed
  - leading MyST anchor lines such as (slug)= are stripped from bodies`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		storage, err := resolveMigrationStorage(migrateDir)
		if err != nil {
			return err
		}

		result, err := storage.Migrate(migrateDryRun)
		if err != nil {
			return err
		}
		if len(result.Entries) == 0 && len(result.TitleToNameIDs) == 0 && len(result.RemovedDependsOnIDs) == 0 && len(result.StrippedMystAnchorIDs) == 0 {
			fmt.Println("No migrations needed")
			return nil
		}

		// One verb-parameterized pass over the four result slices; dry-run vs.
		// applied differs only in the verbs and summary line.
		var migrateVerb, renameVerb, removeVerb, stripVerb string
		var summary string
		if migrateDryRun {
			migrateVerb, renameVerb, removeVerb, stripVerb = "Would migrate", "Would rename", "Would remove", "Would strip"
			summary = "Dry run: %d flat fibers, %d legacy title fields, %d legacy depends-on keys, %d legacy MyST anchors would migrate\n"
		} else {
			migrateVerb, renameVerb, removeVerb, stripVerb = "Migrated", "Renamed", "Removed", "Stripped"
			summary = "Migrated %d flat fibers, %d legacy title fields, %d legacy depends-on keys, %d legacy MyST anchors\n"
		}

		for _, entry := range result.Entries {
			fmt.Printf("%s %s -> %s\n", migrateVerb, entry.OldID, entry.NewID)
		}
		for _, id := range result.TitleToNameIDs {
			fmt.Printf("%s title -> name in %s\n", renameVerb, id)
		}
		for _, id := range result.RemovedDependsOnIDs {
			fmt.Printf("%s legacy depends-on from %s\n", removeVerb, id)
		}
		for _, id := range result.StrippedMystAnchorIDs {
			fmt.Printf("%s legacy MyST anchor from %s\n", stripVerb, id)
		}
		fmt.Printf(
			summary,
			len(result.Entries), len(result.TitleToNameIDs), len(result.RemovedDependsOnIDs), len(result.StrippedMystAnchorIDs),
		)

		return nil
	},
}

var backfillIDsCmd = &cobra.Command{
	Use:   "backfill-ids",
	Short: "Assign ULID ids to fibers that lack one",
	Long: `Writes a frontmatter id (a ULID) into every fiber missing one. Run it only in
the store's canonical checkout, then commit and sync; other checkouts take the
committed ids rather than minting their own.`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		storage, err := resolveMigrationStorage(backfillIDsDir)
		if err != nil {
			return err
		}

		result, err := storage.BackfillIntrinsicIDs(backfillIDsDryRun)
		if err != nil {
			return err
		}
		if len(result.AssignedIDs) == 0 {
			fmt.Println("No intrinsic ids needed")
			return nil
		}

		if backfillIDsDryRun {
			for _, id := range result.AssignedIDs {
				fmt.Printf("Would assign intrinsic id to %s\n", id)
			}
			fmt.Printf("Dry run: %d intrinsic ids would be assigned\n", len(result.AssignedIDs))
			return nil
		}

		for _, id := range result.AssignedIDs {
			fmt.Printf("Assigned intrinsic id to %s\n", id)
		}
		fmt.Printf("Assigned %d intrinsic ids\n", len(result.AssignedIDs))
		return nil
	},
}

var nestCmd = &cobra.Command{
	Use:   "nest <child> <parent>",
	Short: "Move a fiber subtree under a parent",
	Long: `The child keeps its basename and brings its descendants: nesting covariance
under analysis gives analysis/covariance. inputs.from references to moved ids
are rewritten within the store the move runs in, so a move made inside a view
leaves the enclosing store's references as written. Wikilinks stay as written
and keep resolving by basename.

A <parent> that is an existing path in the store is used as spelled, even a
directory with no fiber of its own (roles/ is always the top-level roles
namespace); any other <parent> resolves like a fiber id. When either side
lives outside this view, the move happens in the enclosing store.`,
	Example: `  felt nest covariance analysis`,
	Args:    cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		storage, root, err := requireStore()
		if err != nil {
			return err
		}
		scopeID := resolveCommandScope(root)

		childRef, err := resolveFiberRef(storage, scopeID, args[0])
		if err != nil {
			return err
		}
		parentRef, err := resolveNestParent(storage, scopeID, args[1])
		if err != nil {
			return err
		}
		// When either side lives outside this view the whole move runs in the
		// enclosing store, with the local side rewritten into its outer
		// coordinates: it is one namespace and one git repo, so moving a
		// fiber across a project boundary inside it is an ordinary move.
		childID, parentID, where := liftPair(storage, childRef, parentRef)

		if childID == parentID {
			return fmt.Errorf("child and parent must be different fibers")
		}
		if strings.HasPrefix(parentID, childID+"/") {
			return fmt.Errorf("cannot nest %s under descendant %s", childID, parentID)
		}

		targetID := path.Join(parentID, path.Base(childID))
		if felt.ParentPath(childID) == parentID && childID == targetID {
			return fmt.Errorf("%s is already nested under %s", childID, parentID)
		}
		if err := where.storage.CheckAvailableID(targetID); err != nil {
			return err
		}
		if err := where.storage.MoveSubtree(childID, targetID); err != nil {
			return err
		}

		fmt.Printf("Nested %s under %s as %s%s\n", childID, parentID, targetID, where.location())
		return nil
	},
}

// resolveNestParent resolves nest's destination. A path that exists in the
// store — a fiber's directory, or a namespace directory such as roles/ that
// holds fibers without a fiber of its own — is the destination exactly as
// spelled, so a slug rescue elsewhere in the tree cannot capture it. Only a
// path that exists nowhere falls through to fiber resolution.
func resolveNestParent(storage *felt.Storage, scopeID, arg string) (fiberRef, error) {
	dir := path.Clean(strings.Trim(strings.TrimSpace(arg), "/"))
	if dir == felt.RolesNamespace {
		return fiberRef{storage: storage, id: dir}, nil
	}
	if info, err := os.Stat(filepath.Join(storage.Root(), filepath.FromSlash(dir))); err == nil && info.IsDir() && !strings.HasPrefix(dir, "..") {
		return fiberRef{storage: storage, id: dir}, nil
	}
	return resolveFiberRef(storage, scopeID, arg)
}

var unnestCmd = &cobra.Command{
	Use:   "unnest <child>",
	Short: "Move a nested fiber subtree to the top level",
	Long: `The fiber keeps its basename and brings its descendants: analysis/covariance
becomes covariance. inputs.from references are rewritten as nest does. A fiber
in the enclosing store moves to that store's top level.`,
	Example: `  felt unnest analysis/covariance`,
	Args:    cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		storage, root, err := requireStore()
		if err != nil {
			return err
		}
		scopeID := resolveCommandScope(root)

		child, err := resolveFiberRef(storage, scopeID, args[0])
		if err != nil {
			return err
		}
		if !strings.Contains(child.id, "/") {
			return fmt.Errorf("%s is already top-level", child.id)
		}

		// Top level means top level of the store that holds it: promoting an
		// external fiber lands it at the enclosing store's root, not in here.
		targetID := path.Base(child.id)
		if err := child.storage.CheckAvailableID(targetID); err != nil {
			return err
		}
		if err := child.storage.MoveSubtree(child.id, targetID); err != nil {
			return err
		}

		fmt.Printf("Promoted %s to %s%s\n", child.id, targetID, child.location())
		return nil
	},
}

func init() {
	migrateCmd.GroupID = groupStore
	rootCmd.AddCommand(migrateCmd)
	backfillIDsCmd.GroupID = groupStore
	rootCmd.AddCommand(backfillIDsCmd)
	nestCmd.GroupID = groupFibers
	rootCmd.AddCommand(nestCmd)
	unnestCmd.GroupID = groupFibers
	rootCmd.AddCommand(unnestCmd)

	migrateCmd.Flags().StringVar(&migrateDir, "dir", "", "Project root or .felt directory to migrate (default: the current store)")
	migrateCmd.Flags().BoolVar(&migrateDryRun, "dry-run", false, "Print planned migrations without writing files")
	backfillIDsCmd.Flags().StringVar(&backfillIDsDir, "dir", "", "Project root or .felt directory to backfill (default: the current store)")
	backfillIDsCmd.Flags().BoolVar(&backfillIDsDryRun, "dry-run", false, "Print planned identity assignments without writing files")
}

func resolveMigrationStorage(dir string) (*felt.Storage, error) {
	if dir == "" {
		storage, _, err := requireStore()
		if err != nil {
			return nil, err
		}
		return storage, nil
	}

	clean := filepath.Clean(dir)
	projectRoot := clean
	if filepath.Base(clean) == felt.DirName {
		projectRoot = filepath.Dir(clean)
	}

	storage := felt.NewStorage(projectRoot)
	if !storage.Exists() {
		return nil, fmt.Errorf("no %s directory found in %s", felt.DirName, projectRoot)
	}
	return storage, nil
}
