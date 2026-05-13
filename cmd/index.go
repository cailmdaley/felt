package cmd

import (
	"fmt"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

type indexSyncResult struct {
	Path       string `json:"path"`
	DurationMS int64  `json:"duration_ms"`
}

var indexCmd = &cobra.Command{
	Use:   "index",
	Short: "Maintain the rebuildable SQLite index",
	Long: `Maintains felt's rebuildable SQLite cache.

Markdown files remain the source of truth. The index stores derived search,
relationship, and history rows for fast lookup. Ordinary read commands use the
cache only when it is already available; run 'felt index sync' when you want to
refresh the derived cache explicitly.`,
}

var indexSyncCmd = &cobra.Command{
	Use:   "sync",
	Short: "Synchronize .felt/index.db from markdown",
	Long: `Synchronizes .felt/index.db from the markdown source tree.

This is the explicit maintenance path for narrative back-reference caches,
reverse data-flow consumer caches, history-event freshness, and rebuildable
search rows. Ordinary show/history reads do not perform this work as a side
effect.`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := resolveProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}

		storage := felt.NewStorage(root)
		start := time.Now()
		idx, err := storage.OpenIndex()
		if err != nil {
			return err
		}
		defer idx.Close()

		elapsed := time.Since(start)
		result := indexSyncResult{
			Path:       storage.IndexPath(),
			DurationMS: elapsed.Milliseconds(),
		}
		if jsonOutput {
			return outputJSON(result)
		}
		fmt.Printf("Synced index %s in %s\n", result.Path, elapsed.Round(time.Millisecond))
		return nil
	},
}

func init() {
	rootCmd.AddCommand(indexCmd)
	indexCmd.AddCommand(indexSyncCmd)
}
