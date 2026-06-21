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

// migrateRuntimeCmd lifts the legacy FLAT runtime keys (session_uuid /
// dispatched_at / handed_off_at / run_id) that sit as direct children of a
// shuttle: block into the nested shuttle.runtime sub-mapping (Stage 5). It is the
// one-time, dry-runnable migration that rides the runtime-nesting flip: once the
// daemon writes nested (via mark-runtime) and reads nested-OR-flat, this lifts
// the existing fibers so the on-disk shape matches.
//
// Scoped to fibers THIS host owns (shuttle.host == resolved own-host). That is
// load-bearing under loom git-sync: the same fiber file exists on every host, so
// nesting a fiber owned by a not-yet-flipped remote and syncing it would blind
// that remote's flat-only daemon to its own handoffs (standing-role oscillation).
// Each host migrates only its own fibers when it flips; the daemon's
// nested-OR-flat readers carry any fiber that hasn't been migrated yet. Pass
// --host to target a different owner (e.g. when dry-running on a copy).
var migrateRuntimeCmd = &cobra.Command{
	Use:   "migrate-runtime",
	Short: "Lift flat shuttle runtime keys into the nested shuttle.runtime block",
	Long: `Lifts the flat machine-managed runtime keys (session_uuid, dispatched_at,
handed_off_at, run_id) sitting directly under a shuttle: block into the nested
shuttle.runtime sub-mapping, then drops the flat key. A nested value already
present wins (the flat one is the older write and is dropped). Idempotent.

Scoped to fibers this host owns (shuttle.host == own host) — nesting a fiber a
not-yet-flipped remote owns and syncing it would blind that remote's flat-only
daemon. Use --dir to point at a store, --host to target a different owner, and
--dry-run to print the plan without writing.`,
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
		requestAsyncIndexSync(storage)
		return nil
	},
}

func init() {
	migrateRuntimeCmd.Flags().StringVar(&migrateRuntimeDir, "dir", "", "Project root or .felt directory to migrate")
	migrateRuntimeCmd.Flags().BoolVar(&migrateRuntimeDryRun, "dry-run", false, "Print planned migrations without writing files")
	migrateRuntimeCmd.Flags().StringVar(&migrateRuntimeHost, "host", "", "Owner host to migrate (default: this host's resolved id)")
	shuttleCmd.AddCommand(migrateRuntimeCmd)
}
