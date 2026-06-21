package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

// The single-fiber address verbs — session-name and attach. Both resolve a fiber
// to its canonical id + intrinsic uid (shuttleAddressFiber) and derive the
// worker's tmux session name. Ported from shuttle-ctl's session_name.go /
// attach.go.

// shuttleAddressFiber resolves a single fiber for the from-anywhere address verbs.
// It searches the configured stores cwd-insensitively — the -C / --felt-store
// store when set, otherwise every configured store (LOOM_HOMES → registry →
// ~/loom) until one resolves the query — matching shuttle-ctl's ~/loom default so
// these verbs work from any directory. The scope is the whole store ("") rather
// than the cwd subtree: an operator addressing a worker by id should not have
// resolution depend on where they happen to stand.
func shuttleAddressFiber(query string) (*felt.Felt, error) {
	stores, err := shuttleStores()
	if err != nil {
		return nil, err
	}
	var firstErr error
	for _, store := range stores {
		f, err := felt.NewStorage(store).FindMetadataInScope("", query)
		if err == nil {
			return f, nil
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	if firstErr == nil {
		firstErr = fmt.Errorf("no felt found matching %q", query)
	}
	return nil, firstErr
}

var sessionNameCmd = &cobra.Command{
	Use:   "session-name <fiber>",
	Short: "Print the canonical tmux session name for a fiber",
	Long: `Resolves the fiber and prints the tmux session name Shuttle uses for its
worker (<leaf>-<uid>-shuttle, or the legacy <leaf>-shuttle when the fiber has no
intrinsic uid).`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		f, err := shuttleAddressFiber(args[0])
		if err != nil {
			return err
		}
		session := shuttleTmuxSessionName(f.ID, f.UID)
		if jsonOutput {
			// Emit the dispatch-canonical id (matches the daemon + shuttle-ctl);
			// the session name itself is leaf+uid keyed, so prefix-independent.
			id := f.ID
			if canonical, err := canonicalFiberID(f.Path); err == nil && canonical != "" {
				id = canonical
			}
			return outputJSON(map[string]string{"fiber_id": id, "session": session})
		}
		fmt.Println(session)
		return nil
	},
}

var attachCmd = &cobra.Command{
	Use:   "attach <fiber>",
	Short: "Attach to a running worker's tmux session",
	Long: `Resolves the fiber to Shuttle's canonical tmux session name and execs
'tmux attach'. A worker may be live under either the uid-keyed or the legacy
leaf-only name; attach picks whichever exists, preferring the canonical form.
Exits with a clear error if no session is live.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		f, err := shuttleAddressFiber(args[0])
		if err != nil {
			return err
		}

		session := ""
		for _, candidate := range shuttleTmuxSessionNames(f.ID, f.UID) {
			if tmuxSessionExists(candidate) {
				session = candidate
				break
			}
		}
		if session == "" {
			want := shuttleTmuxSessionName(f.ID, f.UID)
			return fmt.Errorf("no tmux session %q — fiber %s has no live worker\n(run 'felt shuttle ps' to list active workers)", want, args[0])
		}

		tmux, err := exec.LookPath("tmux")
		if err != nil {
			return fmt.Errorf("tmux not found: %w", err)
		}
		// Replace this process with tmux attach.
		return syscall.Exec(tmux, []string{"tmux", "attach", "-t", session}, os.Environ())
	},
}

func init() {
	shuttleCmd.AddCommand(sessionNameCmd)
	shuttleCmd.AddCommand(attachCmd)
}
