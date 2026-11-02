package shuttlecli

import (
	"encoding/json"
	"fmt"

	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

func (a *app) claimCmd() *cobra.Command {
	claimCmd := &cobra.Command{
		Use:   "claim <fiber>",
		Short: "Associate your existing conversation with a draft task",
		Long: `Claim an installed task for the existing terminal conversation on this host.
Use --tmux-session or the current terminal pane; --session supplies the native transcript ID. No worker is launched and
no task is activated. Only after a successful claim, run shuttle resume.
If your session cannot be identified, leave the task as an open draft.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			fiber, err := a.shuttleAddressFiber(args[0])
			if err != nil {
				return err
			}
			block, installed, err := shuttle.BlockOf(fiber)
			if err != nil {
				return err
			}
			if !installed {
				return fmt.Errorf("install %s as a draft before claiming it", fiber.ID)
			}
			own, err := a.resolveOwnHost("")
			if err != nil {
				return err
			}
			if block.Host != own {
				return fmt.Errorf("claim must run on task host %q; this host is %q", block.Host, own)
			}
			session, _ := cmd.Flags().GetString("session")
			tmux, _ := cmd.Flags().GetString("tmux-session")
			pane := ""
			if tmux == "" {
				ref, refErr := a.currentTerminal()
				// A human-born Rex terminal has native IDs but no worker binding.
				// A damaged index must not hide those exact claim coordinates.
				if refErr != nil && !(ref.Backend == "rex" && validRexRef(ref.NativeSession, ref.NativePane)) {
					return fmt.Errorf("cannot identify existing terminal conversation: %w; leave the task as a draft or supply --tmux-session", refErr)
				}
				tmux, pane = ref.NativeSession, ref.NativePane
			}
			if session == "" {
				_, session = a.harnessSessionFromEnv()
			}
			id, err := a.canonicalFiberID(fiber.Path)
			if err != nil {
				return err
			}
			body, err := json.Marshal(map[string]any{"fiber_id": id, "tmux_session": tmux, "tmux_pane": pane, "session_uuid": session, "agent": block.Agent})
			if err != nil {
				return err
			}
			endpoint, err := a.daemonEndpoint("/api/v1/claim")
			if err != nil {
				return err
			}
			response, err := a.postDaemonContext(cmd.Context(), endpoint, body, daemonPostTimeout)
			if err != nil {
				return fmt.Errorf("claim not confirmed; do not activate the task: %w", err)
			}
			var result struct {
				Claimed bool `json:"claimed"`
			}
			if err := json.Unmarshal(response, &result); err != nil {
				return fmt.Errorf("claim response unreadable; do not activate the task: %w", err)
			}
			if !result.Claimed {
				return fmt.Errorf("claim rejected; leave the task as a draft: %s", response)
			}
			if a.json {
				var value any
				if err := json.Unmarshal(response, &value); err != nil {
					return err
				}
				return a.outputJSON(value)
			}
			fmt.Fprintf(a.env.Stdout, "Claimed %s for the existing conversation. Activate with shuttle resume %s.\n", fiber.ID, fiber.ID)
			return nil
		},
	}
	claimCmd.Flags().String("session", "", "Exact native conversation ID (otherwise detected from this terminal harness)")
	claimCmd.Flags().String("tmux-session", "", "Existing tmux session name (otherwise detected from this pane)")
	return claimCmd
}
