package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var (
	markRuntimeDispatchedAt string
	markRuntimeSession      string
	markRuntimeRunID        string
	markRuntimeHandedOffAt  string
	markRuntimeHost         string
)

// markRuntimeCmd is the daemon-facing runtime-stamp verb: it sets whichever
// shuttle.runtime continuation fields are named by flags, nested under
// shuttle.runtime, preserving every config sibling and every unspecified runtime
// key. It is felt's single channel for the daemon's runtime writes (the dispatch
// marker, the re-arm conclude) — the daemon shells this instead of editing the
// fiber .md itself, so ALL runtime nesting lives in felt's yaml.Node engine, not
// in the daemon's text surgery (Stage 5, Option B).
//
// Unlike `handoff` (the worker's exit ritual, which also ends the tmux session),
// mark-runtime only writes the fields — no session management. An empty flag
// value removes that key (omitempty), so a re-stamp can clear a field.
//
// --host is load-bearing: the daemon passes its authoritative own_host_id so the
// ownership guard resolves locally instead of calling back to GET /api/v1/state.
// That callback is RE-ENTRANT — a daemon-shelled write runs while the Poller is
// blocked on this subprocess, so /api/v1/state would time out (~1.5s stall) and
// resolveOwnHost would fall back to os.Hostname(), which on a host whose owner id
// is an alias (candide vs c03) mismatches the block's host and silently fails the
// write (resurrecting standing-role oscillation). With --host neither happens.
var markRuntimeCmd = &cobra.Command{
	Use:   "mark-runtime <fiber>",
	Short: "Stamp machine-managed shuttle.runtime fields (daemon-facing)",
	Long: `Sets the shuttle.runtime continuation fields named by flags
(--dispatched-at, --session, --run-id, --handed-off-at), nested under
shuttle.runtime, preserving config and any unspecified runtime key. An empty
flag value removes that key. This is the daemon's channel for writing
continuation state: the daemon shells it rather than editing the fiber file, so
the runtime nesting lives in one engine (felt). Unlike 'handoff', it never
touches tmux.

The daemon passes --host <own_host_id> so the ownership guard resolves without a
re-entrant round-trip back to the daemon it is being shelled from.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		f, st, _, err := resolveOwnedShuttleFiberAs(args[0], markRuntimeHost)
		if err != nil {
			return err
		}

		fields := []struct{ flag, key, val string }{
			{"dispatched-at", "dispatched_at", markRuntimeDispatchedAt},
			{"session", "session_uuid", markRuntimeSession},
			{"run-id", "run_id", markRuntimeRunID},
			{"handed-off-at", "handed_off_at", markRuntimeHandedOffAt},
		}

		set := false
		for _, fl := range fields {
			if !cmd.Flags().Changed(fl.flag) {
				continue
			}
			if err := f.SetShuttleRuntimeField(fl.key, fl.val); err != nil {
				return err
			}
			set = true
		}
		if !set {
			return fmt.Errorf("mark-runtime: pass at least one of --dispatched-at/--session/--run-id/--handed-off-at")
		}

		if err := st.Write(f); err != nil {
			return fmt.Errorf("writing fiber: %w", err)
		}
		fmt.Printf("marked runtime for %s\n", args[0])
		return nil
	},
}

func init() {
	markRuntimeCmd.Flags().StringVar(&markRuntimeDispatchedAt, "dispatched-at", "", "RFC3339 UTC dispatch instant → shuttle.runtime.dispatched_at")
	markRuntimeCmd.Flags().StringVar(&markRuntimeSession, "session", "", "Resumable session UUID → shuttle.runtime.session_uuid")
	markRuntimeCmd.Flags().StringVar(&markRuntimeRunID, "run-id", "", "Standing-role run id → shuttle.runtime.run_id")
	markRuntimeCmd.Flags().StringVar(&markRuntimeHandedOffAt, "handed-off-at", "", "RFC3339 UTC clean-exit instant → shuttle.runtime.handed_off_at")
	markRuntimeCmd.Flags().StringVar(&markRuntimeHost, "host", "", "Owner host for the ownership guard (the daemon's own_host_id); avoids a re-entrant /api/v1/state call")
	shuttleCmd.AddCommand(markRuntimeCmd)
}
