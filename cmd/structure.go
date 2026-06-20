package cmd

import (
	"fmt"
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
	Short: "Normalize fibers into the current storage model",
	Long: `Normalizes legacy felt storage details into the current model.

This migration pass:
- converts legacy top-level .felt/*.md files into directory-based fibers
- rewrites frontmatter key title -> name
- removes inert legacy depends-on frontmatter
- strips leading MyST anchor lines like (slug)= from fiber bodies

Each migrated flat fiber lands at <slug>/<slug>.md, and any inputs.from
references to migrated hex IDs are rewritten, and myst.yml is ensured.

A single bare .md at .felt/ root is the entry-point fiber and is preserved —
only multiple bare files are treated as orphaned legacy and migrated.`,
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

		// One verb-parameterized pass over the four result slices. The only
		// behavioral differences (early return vs. index sync) stay outside the
		// printing below.
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

		if migrateDryRun {
			return nil
		}
		requestAsyncIndexSync(storage)
		return nil
	},
}

var backfillIDsCmd = &cobra.Command{
	Use:   "backfill-ids",
	Short: "Assign intrinsic ULID ids to existing fibers",
	Long: `Assigns a frontmatter id ULID to every fiber missing one.

Run this only on the canonical owner of a store, then sync the resulting files.
Replicas should inherit the committed ids rather than minting their own.`,
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
		requestAsyncIndexSync(storage)
		return nil
	},
}

var nestCmd = &cobra.Command{
	Use:   "nest <child> <parent>",
	Short: "Move a fiber under another fiber",
	Long:  `Moves an existing fiber subtree under a parent fiber, rewriting IDs and dependencies.`,
	Args:  cobra.ExactArgs(2),
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

		child, err := felt.FindByScope(felts, scopeID, args[0])
		if err != nil {
			return err
		}
		parent, err := felt.FindByScope(felts, scopeID, args[1])
		if err != nil {
			return err
		}
		if child.ID == parent.ID {
			return fmt.Errorf("child and parent must be different fibers")
		}
		if strings.HasPrefix(parent.ID, child.ID+"/") {
			return fmt.Errorf("cannot nest %s under descendant %s", child.ID, parent.ID)
		}

		targetID := path.Join(parent.ID, path.Base(child.ID))
		if path.Dir(child.ID) == parent.ID && child.ID == targetID {
			return fmt.Errorf("%s is already nested under %s", child.ID, parent.ID)
		}
		if err := storage.CheckAvailableID(targetID); err != nil {
			return err
		}
		if err := storage.MoveSubtree(child.ID, targetID); err != nil {
			return err
		}
		requestAsyncIndexSync(storage)

		fmt.Printf("Nested %s under %s as %s\n", child.ID, parent.ID, targetID)
		return nil
	},
}

var unnestCmd = &cobra.Command{
	Use:   "unnest <child>",
	Short: "Promote a nested fiber to the top level",
	Long:  `Moves a nested fiber subtree to the top level, rewriting IDs and dependencies.`,
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

		child, err := felt.FindByScope(felts, scopeID, args[0])
		if err != nil {
			return err
		}
		if !strings.Contains(child.ID, "/") {
			return fmt.Errorf("%s is already top-level", child.ID)
		}

		targetID := path.Base(child.ID)
		if err := storage.CheckAvailableID(targetID); err != nil {
			return err
		}
		if err := storage.MoveSubtree(child.ID, targetID); err != nil {
			return err
		}
		requestAsyncIndexSync(storage)

		fmt.Printf("Promoted %s to %s\n", child.ID, targetID)
		return nil
	},
}

func init() {
	rootCmd.AddCommand(migrateCmd)
	rootCmd.AddCommand(backfillIDsCmd)
	rootCmd.AddCommand(nestCmd)
	rootCmd.AddCommand(unnestCmd)

	migrateCmd.Flags().StringVar(&migrateDir, "dir", "", "Project root or .felt directory to migrate")
	migrateCmd.Flags().BoolVar(&migrateDryRun, "dry-run", false, "Print planned migrations without writing files")
	backfillIDsCmd.Flags().StringVar(&backfillIDsDir, "dir", "", "Project root or .felt directory to backfill")
	backfillIDsCmd.Flags().BoolVar(&backfillIDsDryRun, "dry-run", false, "Print planned identity assignments without writing files")
}

func resolveMigrationStorage(dir string) (*felt.Storage, error) {
	if dir == "" {
		root, err := resolveProjectRoot()
		if err != nil {
			return nil, fmt.Errorf("not in a felt repository")
		}
		return felt.NewStorage(root), nil
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
