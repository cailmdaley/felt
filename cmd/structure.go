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
	migrateDir    string
	migrateDryRun bool
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
references to migrated hex IDs are rewritten,
and myst.yml is ensured.`,
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

		if migrateDryRun {
			for _, entry := range result.Entries {
				fmt.Printf("Would migrate %s -> %s\n", entry.OldID, entry.NewID)
			}
			for _, id := range result.TitleToNameIDs {
				fmt.Printf("Would rename title -> name in %s\n", id)
			}
			for _, id := range result.RemovedDependsOnIDs {
				fmt.Printf("Would remove legacy depends-on from %s\n", id)
			}
			for _, id := range result.StrippedMystAnchorIDs {
				fmt.Printf("Would strip legacy MyST anchor from %s\n", id)
			}
			fmt.Printf(
				"Dry run: %d flat fibers, %d legacy title fields, %d legacy depends-on keys, %d legacy MyST anchors would migrate\n",
				len(result.Entries), len(result.TitleToNameIDs), len(result.RemovedDependsOnIDs), len(result.StrippedMystAnchorIDs),
			)
			return nil
		}

		for _, entry := range result.Entries {
			fmt.Printf("Migrated %s -> %s\n", entry.OldID, entry.NewID)
		}
		for _, id := range result.TitleToNameIDs {
			fmt.Printf("Renamed title -> name in %s\n", id)
		}
		for _, id := range result.RemovedDependsOnIDs {
			fmt.Printf("Removed legacy depends-on from %s\n", id)
		}
		for _, id := range result.StrippedMystAnchorIDs {
			fmt.Printf("Stripped legacy MyST anchor from %s\n", id)
		}
		fmt.Printf(
			"Migrated %d flat fibers, %d legacy title fields, %d legacy depends-on keys, %d legacy MyST anchors\n",
			len(result.Entries), len(result.TitleToNameIDs), len(result.RemovedDependsOnIDs), len(result.StrippedMystAnchorIDs),
		)
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

		fmt.Printf("Promoted %s to %s\n", child.ID, targetID)
		return nil
	},
}

func init() {
	rootCmd.AddCommand(migrateCmd)
	rootCmd.AddCommand(nestCmd)
	rootCmd.AddCommand(unnestCmd)

	migrateCmd.Flags().StringVar(&migrateDir, "dir", "", "Project root or .felt directory to migrate")
	migrateCmd.Flags().BoolVar(&migrateDryRun, "dry-run", false, "Print planned migrations without writing files")
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
