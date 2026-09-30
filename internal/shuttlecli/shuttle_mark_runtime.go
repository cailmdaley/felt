package shuttlecli

import (
	"fmt"

	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

var (
	markRuntimeDispatchedAt string
	markRuntimeSession      string
	markRuntimeRunID        string
	markRuntimeHandedOffAt  string
	markRuntimeMeeting      string
)

// markRuntimeCmd is the daemon-facing runtime-stamp verb: it sets whichever
// shuttle.runtime continuation fields are named by flags, nested under
// shuttle.runtime, preserving every config sibling and every unspecified runtime
// key. It is felt's single channel for the daemon's runtime writes (the dispatch
// marker, the re-arm conclude) — the daemon shells this instead of editing the
// fiber .md itself, so runtime nesting stays in Shuttle's YAML-node facet API.
//
// Unlike `handoff` (the worker's exit ritual, which also ends the tmux session),
// mark-runtime only writes the fields — no session management. An empty flag
// value removes that key (omitempty), so a re-stamp can clear a field.
// Ownership resolves the way resolveOwnedShuttleFiber resolves it for every
// other verb.
var markRuntimeCmd = &cobra.Command{
	Use:   "mark-runtime <fiber>",
	Short: "Stamp machine-managed shuttle.runtime fields (daemon-facing)",
	Long: `Sets the shuttle.runtime continuation fields named by flags
(--dispatched-at, --session, --run-id, --handed-off-at, --meeting), nested under
shuttle.runtime, preserving config and any unspecified runtime key. An empty
flag value removes that key. This is the daemon's channel for writing
continuation state: the daemon shells it rather than editing the fiber file, so
the runtime nesting lives in one engine (felt). Unlike 'handoff', it never
touches tmux.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		f, st, _, ref, unlock, err := resolveOwnedShuttleFiber(args[0], "")
		if err != nil {
			return err
		}
		defer unlock()
		if err := ensureOwnedHere(f, args[0]); err != nil {
			return err
		}

		fields := []struct{ flag, key, val string }{
			{"dispatched-at", "dispatched_at", markRuntimeDispatchedAt},
			{"session", "session_uuid", markRuntimeSession},
			{"run-id", "run_id", markRuntimeRunID},
			{"handed-off-at", "handed_off_at", markRuntimeHandedOffAt},
			{"meeting", "meeting", markRuntimeMeeting},
		}

		set := false
		for _, fl := range fields {
			if !cmd.Flags().Changed(fl.flag) {
				continue
			}
			if err := shuttle.SetRuntimeField(f, fl.key, fl.val); err != nil {
				return err
			}
			set = true
		}
		if !set {
			return fmt.Errorf("mark-runtime: pass at least one of --dispatched-at/--session/--run-id/--handed-off-at/--meeting")
		}

		if err := st.Write(f); err != nil {
			return fmt.Errorf("writing fiber: %w", err)
		}
		fmt.Printf("marked runtime for %s%s\n", args[0], ref.Location())
		return nil
	},
}

func init() {
	markRuntimeCmd.Flags().StringVar(&markRuntimeDispatchedAt, "dispatched-at", "", "RFC3339 UTC dispatch instant → shuttle.runtime.dispatched_at")
	markRuntimeCmd.Flags().StringVar(&markRuntimeSession, "session", "", "Resumable session UUID → shuttle.runtime.session_uuid")
	markRuntimeCmd.Flags().StringVar(&markRuntimeRunID, "run-id", "", "Standing-role run id → shuttle.runtime.run_id")
	markRuntimeCmd.Flags().StringVar(&markRuntimeHandedOffAt, "handed-off-at", "", "RFC3339 UTC clean-exit instant → shuttle.runtime.handed_off_at")
	markRuntimeCmd.Flags().StringVar(&markRuntimeMeeting, "meeting", "", "Launch id of the meeting this fiber scribes → shuttle.runtime.meeting")
	addShuttleCommand(markRuntimeCmd)
}
