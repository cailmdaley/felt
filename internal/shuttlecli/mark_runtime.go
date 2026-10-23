package shuttlecli

import (
	"fmt"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

// markRuntimeCmd is the daemon-facing runtime-stamp verb: it sets whichever
// shuttle.runtime continuation fields are named by flags, nested under
// shuttle.runtime, preserving every config sibling and every unspecified runtime
// key. It is Shuttle's single channel for the daemon's runtime writes (the
// dispatch marker, the re-arm conclude) — the daemon shells this instead of
// editing the fiber .md itself, so runtime nesting stays in Shuttle's YAML-node facet API.
//
// Unlike `handoff` (the worker's exit ritual, which also ends the tmux session),
// mark-runtime only writes the fields — no session management. An empty flag
// value removes that key (omitempty), so a re-stamp can clear a field.
// Ownership resolves the way resolveOwnedShuttleFiber resolves it for every
// other verb.
func (a *app) markRuntimeCmd() *cobra.Command {
	var markRuntimeDispatchedAt string
	var markRuntimeSession string
	var markRuntimeRunID string
	var markRuntimeHandedOffAt string
	var markRuntimeMeeting string
	var markRuntimePane string
	var ifDispatchedAt string
	markRuntimeCmd := &cobra.Command{
		Use:   "mark-runtime <fiber>",
		Short: "Stamp machine-managed shuttle.runtime fields (daemon-facing)",
		Long: `Sets the shuttle.runtime continuation fields named by flags
(--dispatched-at, --session, --pane, --run-id, --handed-off-at, --meeting),
nested under shuttle.runtime, preserving config and any unspecified runtime
key. An empty flag value removes that key. This is the daemon's channel for
writing continuation state: the daemon shells it rather than editing the fiber
file, so the runtime nesting lives in one engine (Shuttle). Unlike 'handoff',
it never touches tmux.

--if-dispatched-at makes the write conditional on the dispatch generation it
applies to: the current shuttle.runtime.dispatched_at must equal the value
exactly (an empty value requires no stamp). The comparison and the write hold
the same fiber lock; a mismatch fails without changing the file.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			f, st, _, ref, unlock, err := a.resolveOwnedShuttleFiber(args[0], "")
			if err != nil {
				return err
			}
			defer unlock()
			if err := a.ensureOwnedHere(f, args[0]); err != nil {
				return err
			}

			if cmd.Flags().Changed("if-dispatched-at") {
				current := ""
				runtime := felt.MappingValueNode(f.ExtraFields["shuttle"], "runtime")
				if node := felt.MappingValueNode(runtime, "dispatched_at"); node != nil {
					current = node.Value
				}
				if current != ifDispatchedAt {
					return fmt.Errorf("mark-runtime: dispatched_at mismatch for %s: got %q, expected %q", args[0], current, ifDispatchedAt)
				}
			}

			fields := []struct{ flag, key, val string }{
				{"dispatched-at", "dispatched_at", markRuntimeDispatchedAt},
				{"session", "session_uuid", markRuntimeSession},
				{"pane", "pane", markRuntimePane},
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
				return fmt.Errorf("mark-runtime: pass at least one of --dispatched-at/--session/--pane/--run-id/--handed-off-at/--meeting")
			}

			if err := st.Write(f); err != nil {
				return fmt.Errorf("writing fiber: %w", err)
			}
			fmt.Fprintf(a.env.Stdout, "marked runtime for %s%s\n", args[0], ref.Location())
			return nil
		},
	}
	markRuntimeCmd.Flags().StringVar(&markRuntimeDispatchedAt, "dispatched-at", "", "RFC3339 UTC dispatch instant → shuttle.runtime.dispatched_at")
	markRuntimeCmd.Flags().StringVar(&markRuntimeSession, "session", "", "Resumable session UUID → shuttle.runtime.session_uuid")
	markRuntimeCmd.Flags().StringVar(&markRuntimeRunID, "run-id", "", "Standing-role run id → shuttle.runtime.run_id")
	markRuntimeCmd.Flags().StringVar(&markRuntimeHandedOffAt, "handed-off-at", "", "RFC3339 UTC clean-exit instant → shuttle.runtime.handed_off_at")
	markRuntimeCmd.Flags().StringVar(&markRuntimeMeeting, "meeting", "", "Launch id of the meeting this fiber scribes → shuttle.runtime.meeting")
	markRuntimeCmd.Flags().StringVar(&markRuntimePane, "pane", "", "Claimed pane binding <pid>:<start> → shuttle.runtime.pane")
	markRuntimeCmd.Flags().StringVar(&ifDispatchedAt, "if-dispatched-at", "", "Write only if the current dispatch stamp matches exactly (checked under the fiber lock)")
	return markRuntimeCmd
}
