package feltcli

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

func (a *app) migrateCmd() *cobra.Command {
	var migrateDir string
	var migrateDryRun bool
	command := &cobra.Command{
		Use:   "migrate",
		Short: "Convert legacy store layouts to the current model",
		Long: `Converts legacy storage in place:
  - two or more bare .felt/*.md files become <slug>/<slug>.md fibers, and
    inputs.from references to their old ids are rewritten (a single bare .md
    is the store's entry-point fiber and stays)
  - stray fiber files, a bare <dir>/<slug>.md with fiber frontmatter below
    the root, fold into <dir>/<slug>/<slug>.md (markdown without fiber
    frontmatter is a companion file and stays)
  - frontmatter title becomes name
  - inert depends-on frontmatter is removed
  - leading MyST anchor lines such as (slug)= are stripped from bodies

A stray that cannot fold safely (its target already exists, its <slug> is a
file or symlink, or the stray is itself a symlink) is left in place with the
reason; the rest of the pass runs and migrate exits non-zero until it is moved
by hand.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			storage, err := a.resolveMigrationStorage(migrateDir)
			if err != nil {
				return err
			}

			result, err := storage.Migrate(migrateDryRun)
			if err != nil {
				return err
			}
			if len(result.Entries) == 0 && len(result.Strays) == 0 && len(result.TitleToNameIDs) == 0 && len(result.RemovedDependsOnIDs) == 0 && len(result.StrippedMystAnchorIDs) == 0 {
				fmt.Fprintln(a.env.Stdout, "No migrations needed")
				return nil
			}

			// One verb-parameterized pass over the result slices; dry-run vs.
			// applied differs only in the verbs and summary line.
			var migrateVerb, foldVerb, renameVerb, removeVerb, stripVerb string
			var summary string
			if migrateDryRun {
				migrateVerb, foldVerb, renameVerb, removeVerb, stripVerb = "Would migrate", "Would fold", "Would rename", "Would remove", "Would strip"
				summary = "Dry run: %d flat fibers, %d stray fiber files, %d legacy title fields, %d legacy depends-on keys, %d legacy MyST anchors would migrate\n"
			} else {
				migrateVerb, foldVerb, renameVerb, removeVerb, stripVerb = "Migrated", "Folded", "Renamed", "Removed", "Stripped"
				summary = "Migrated %d flat fibers, %d stray fiber files, %d legacy title fields, %d legacy depends-on keys, %d legacy MyST anchors\n"
			}

			for _, entry := range result.Entries {
				fmt.Fprintf(a.env.Stdout, "%s %s -> %s\n", migrateVerb, entry.OldID, entry.NewID)
			}
			folded, blocked := 0, 0
			for _, sf := range result.Strays {
				if sf.Blocked != "" {
					blocked++
					fmt.Fprintf(a.env.Stdout, "Cannot fold .felt/%s -> .felt/%s: %s\n", sf.Rel, sf.TargetRel, sf.Blocked)
					continue
				}
				folded++
				fmt.Fprintf(a.env.Stdout, "%s .felt/%s -> .felt/%s\n", foldVerb, sf.Rel, sf.TargetRel)
			}
			for _, id := range result.TitleToNameIDs {
				fmt.Fprintf(a.env.Stdout, "%s title -> name in %s\n", renameVerb, id)
			}
			for _, id := range result.RemovedDependsOnIDs {
				fmt.Fprintf(a.env.Stdout, "%s legacy depends-on from %s\n", removeVerb, id)
			}
			for _, id := range result.StrippedMystAnchorIDs {
				fmt.Fprintf(a.env.Stdout, "%s legacy MyST anchor from %s\n", stripVerb, id)
			}
			fmt.Fprintf(a.env.Stdout,
				summary,
				len(result.Entries), folded, len(result.TitleToNameIDs), len(result.RemovedDependsOnIDs), len(result.StrippedMystAnchorIDs),
			)

			if blocked > 0 {
				return fmt.Errorf("%d stray fiber file(s) could not be folded and need moving by hand", blocked)
			}
			return nil
		},
	}
	command.GroupID = groupStore
	command.Flags().StringVar(&migrateDir, "dir", "", "Project root or .felt directory to migrate (default: the current store)")
	command.Flags().BoolVar(&migrateDryRun, "dry-run", false, "Print planned migrations without writing files")
	return command
}

func (a *app) backfillIDsCmd() *cobra.Command {
	var backfillIDsDir string
	var backfillIDsDryRun bool
	command := &cobra.Command{
		Use:   "backfill-ids",
		Short: "Assign ULID ids to fibers that lack one",
		Long: `Writes a frontmatter id (a ULID) into every fiber missing one. Run it only in
the store's canonical checkout, then commit and sync; other checkouts take the
committed ids rather than minting their own.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			storage, err := a.resolveMigrationStorage(backfillIDsDir)
			if err != nil {
				return err
			}

			result, err := storage.BackfillIntrinsicIDs(backfillIDsDryRun)
			if err != nil {
				return err
			}
			if len(result.AssignedIDs) == 0 {
				fmt.Fprintln(a.env.Stdout, "No intrinsic ids needed")
				return nil
			}

			if backfillIDsDryRun {
				for _, id := range result.AssignedIDs {
					fmt.Fprintf(a.env.Stdout, "Would assign intrinsic id to %s\n", id)
				}
				fmt.Fprintf(a.env.Stdout, "Dry run: %d intrinsic ids would be assigned\n", len(result.AssignedIDs))
				return nil
			}

			for _, id := range result.AssignedIDs {
				fmt.Fprintf(a.env.Stdout, "Assigned intrinsic id to %s\n", id)
			}
			fmt.Fprintf(a.env.Stdout, "Assigned %d intrinsic ids\n", len(result.AssignedIDs))
			return nil
		},
	}
	command.GroupID = groupStore
	command.Flags().StringVar(&backfillIDsDir, "dir", "", "Project root or .felt directory to backfill (default: the current store)")
	command.Flags().BoolVar(&backfillIDsDryRun, "dry-run", false, "Print planned identity assignments without writing files")
	return command
}

func (a *app) nestCmd() *cobra.Command {
	command := &cobra.Command{
		Use:   "nest <child> <parent>",
		Short: "Move a fiber subtree under a parent",
		Long: `The child keeps its basename and brings its descendants: nesting covariance
under analysis gives analysis/covariance. Every wikilink, markdown link, and
inputs.from whose path the move would break is rewritten, whether it names a
moved fiber or would be captured by one, across the enclosing store too when
this is a view; each fiber rewritten is named.

A <parent> that is an existing path in the store is used as spelled, even a
directory with no fiber of its own (roles/ is always the top-level roles
namespace); any other <parent>, and the child, resolve like a fiber id, except
that an id resolving only by its last segment or as a prefix completion is
refused, naming the fiber it would have reached. When either side lives
outside this view, the move happens in the enclosing store.`,
		Example: `  felt nest covariance analysis`,
		Args:    cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			storage, root, err := felt.RequireStore(a.env, a.dir)
			if err != nil {
				return err
			}
			scopeID := felt.CommandScope(a.env, root, a.dir)

			childRef, err := felt.ResolveExactRef(storage, scopeID, args[0])
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
			if err := where.Storage.CheckAvailableID(targetID); err != nil {
				return err
			}
			result, err := where.Storage.MoveSubtree(childID, targetID)
			if err != nil {
				// A write that fails after the rename leaves the subtree moved;
				// name what was rewritten so the rest can be finished by hand.
				if result != nil {
					a.printRewrittenRefs(where.Storage, result)
				}
				return err
			}

			fmt.Fprintf(a.env.Stdout, "Nested %s under %s as %s%s\n", childID, parentID, targetID, where.Location())
			a.printRewrittenRefs(where.Storage, result)
			return nil
		},
	}
	command.GroupID = groupFibers
	return command
}

// resolveNestParent resolves nest's destination. A path that exists in the
// store — a fiber's directory, or a namespace directory such as roles/ that
// holds fibers without a fiber of its own — is the destination exactly as
// spelled, so a slug rescue elsewhere in the tree cannot capture it. Only a
// path that exists nowhere falls through to fiber resolution.
func resolveNestParent(storage *felt.Storage, scopeID, arg string) (felt.Ref, error) {
	dir := path.Clean(strings.Trim(strings.TrimSpace(arg), "/"))
	if dir == felt.RolesNamespace {
		return felt.Ref{Storage: storage, ID: dir}, nil
	}
	if info, err := os.Stat(filepath.Join(storage.Root(), filepath.FromSlash(dir))); err == nil && info.IsDir() && !strings.HasPrefix(dir, "..") {
		return felt.Ref{Storage: storage, ID: dir}, nil
	}
	return felt.ResolveExactRef(storage, scopeID, arg)
}

func (a *app) unnestCmd() *cobra.Command {
	command := &cobra.Command{
		Use:   "unnest <child>",
		Short: "Move a nested fiber subtree to the top level",
		Long: `The fiber keeps its basename and brings its descendants: analysis/covariance
becomes covariance. References the move would break are rewritten, and guessed
ids refused, as nest does. A fiber in the enclosing store moves to that
store's top level.`,
		Example: `  felt unnest analysis/covariance`,
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			storage, root, err := felt.RequireStore(a.env, a.dir)
			if err != nil {
				return err
			}
			scopeID := felt.CommandScope(a.env, root, a.dir)

			child, err := felt.ResolveExactRef(storage, scopeID, args[0])
			if err != nil {
				return err
			}
			if !strings.Contains(child.ID, "/") {
				return fmt.Errorf("%s is already top-level", child.ID)
			}

			// Top level means top level of the store that holds it: promoting an
			// external fiber lands it at the enclosing store's root, not in here.
			targetID := path.Base(child.ID)
			if err := child.Storage.CheckAvailableID(targetID); err != nil {
				return err
			}
			result, err := child.Storage.MoveSubtree(child.ID, targetID)
			if err != nil {
				// A write that fails after the rename leaves the subtree moved;
				// name what was rewritten so the rest can be finished by hand.
				if result != nil {
					a.printRewrittenRefs(child.Storage, result)
				}
				return err
			}

			fmt.Fprintf(a.env.Stdout, "Promoted %s to %s%s\n", child.ID, targetID, child.Location())
			a.printRewrittenRefs(child.Storage, result)
			return nil
		},
	}
	command.GroupID = groupFibers
	return command
}

// printRewrittenRefs names each fiber whose references a move rewrote: those
// in the store that moved by their ids there, those elsewhere in its
// enclosing store by their ids in it.
func (a *app) printRewrittenRefs(storage *felt.Storage, result *felt.MoveResult) {
	for _, id := range result.Rewritten {
		fmt.Fprintf(a.env.Stdout, "Rewrote references in %s\n", id)
	}
	for _, id := range result.Outside {
		fmt.Fprintf(a.env.Stdout, "Rewrote references in %s (in %s)\n", id, storage.ExternalRefs().Root())
	}
}

func (a *app) resolveMigrationStorage(dir string) (*felt.Storage, error) {
	if dir == "" {
		storage, _, err := felt.RequireStore(a.env, a.dir)
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
