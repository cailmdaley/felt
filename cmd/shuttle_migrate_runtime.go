package cmd

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
)

var (
	migrateRuntimeDir    string
	migrateRuntimeDryRun bool
	migrateRuntimeHost   string
)

// migrateRuntimeCmd lifts FLAT runtime keys (session_uuid / dispatched_at /
// handed_off_at / run_id) that sit as direct children of a shuttle: block into
// the nested shuttle.runtime sub-mapping, the only shape writers emit and the
// daemon reads. It is dry-runnable and idempotent.
//
// Scoped to fibers THIS host owns (shuttle.host == resolved own-host): under
// loom git-sync the same fiber file exists on every host, and only its owner
// writes it. Pass --host to target a different owner (e.g. when dry-running on
// a copy).
var migrateRuntimeCmd = &cobra.Command{
	Use:   "migrate-runtime",
	Short: "Lift flat shuttle runtime keys into the nested shuttle.runtime block",
	Long: `Lifts the flat machine-managed runtime keys (session_uuid, dispatched_at,
handed_off_at, run_id) sitting directly under a shuttle: block into the nested
shuttle.runtime sub-mapping, then drops the flat key. A nested value already
present wins (the flat one is the older write and is dropped). Idempotent.

Scoped to fibers this host owns (shuttle.host == own host), so it never
rewrites a fiber another daemon owns. Use --dir to point at a store (default:
the current store), --host to target a different owner, and --dry-run to print
the plan without writing.

Every writer emits nested keys, and the daemon reads only nested ones — a fiber
with flat keys alone reads as having no continuation state. Such a fiber comes
only from a store no current writer has touched (an old checkout, an unpushed
tree, a backup); this verb is the remedy when one turns up.`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		ownHost, err := resolveOwnHost(migrateRuntimeHost)
		if err != nil {
			return err
		}

		storage, err := resolveMigrationStorage(migrateRuntimeDir)
		if err != nil {
			return err
		}

		fibers, err := storage.List()
		if err != nil {
			return err
		}

		verb := "Lifted"
		if migrateRuntimeDryRun {
			verb = "Would lift"
		}

		migrated, skippedForeign := 0, 0
		for _, f := range fibers {
			block, ok, err := f.ShuttleBlock()
			if err != nil {
				return fmt.Errorf("%s: %w", f.ID, err)
			}
			if !ok {
				continue
			}
			if strings.TrimSpace(block.Host) != ownHost {
				skippedForeign++
				continue
			}

			lifted, changed := f.MigrateRuntimeNesting()
			if !changed {
				continue
			}
			migrated++
			fmt.Printf("%s %s → shuttle.runtime in %s\n", verb, strings.Join(lifted, ", "), f.ID)

			if !migrateRuntimeDryRun {
				if err := storage.Write(f); err != nil {
					return fmt.Errorf("writing %s: %w", f.ID, err)
				}
			}
		}

		if migrated == 0 {
			fmt.Printf("No flat runtime keys to migrate for host %q (%d foreign fibers skipped)\n", ownHost, skippedForeign)
			return nil
		}
		if migrateRuntimeDryRun {
			fmt.Printf("Dry run: %d fibers owned by %q would migrate (%d foreign skipped)\n", migrated, ownHost, skippedForeign)
			return nil
		}
		fmt.Printf("Migrated %d fibers owned by %q (%d foreign skipped)\n", migrated, ownHost, skippedForeign)
		return nil
	},
}

func init() {
	migrateRuntimeCmd.Flags().StringVar(&migrateRuntimeDir, "dir", "", "Project root or .felt directory to migrate")
	migrateRuntimeCmd.Flags().BoolVar(&migrateRuntimeDryRun, "dry-run", false, "Print planned migrations without writing files")
	migrateRuntimeCmd.Flags().StringVar(&migrateRuntimeHost, "host", "", "Owner host to migrate (default: this host's resolved id)")
	shuttleCmd.AddCommand(migrateRuntimeCmd)
}
