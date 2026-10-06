package shuttlecli

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

// tmuxCurrentSession names the tmux session of this terminal's pane
// (app.claimTmuxSession).
func (a *app) tmuxCurrentSession() (string, error) {
	if a.env.Getenv("TMUX") == "" {
		return "", fmt.Errorf("this terminal is outside tmux")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	pane := a.env.Getenv("TMUX_PANE")
	if pane == "" {
		return "", fmt.Errorf("the current tmux pane is unknown")
	}
	args := []string{"display-message", "-p", "-t", pane}
	out, err := a.env.CommandContext(ctx, "tmux", append(args, "#{session_name}")...).Output()
	if err != nil {
		return "", err
	}
	name := strings.TrimSpace(string(out))
	if name == "" {
		return "", fmt.Errorf("tmux returned no session name")
	}
	return name, nil
}

func (a *app) claimCmd() *cobra.Command {
	claimCmd := &cobra.Command{
		Use:   "claim <fiber>",
		Short: "Associate your existing conversation with a draft task",
		Long: `Claim an installed task for the existing conversation on this host.
App claims use --session or CODEX_THREAD_ID and require a verified native App
Server conversation. Terminal claims use --tmux-session or the current tmux
pane; --session supplies the native transcript ID. No worker is launched and
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
			surface, _ := cmd.Flags().GetString("surface")
			expected := block.Surface
			if expected == "" {
				expected = "cli"
			}
			if surface == "" {
				surface = expected
			}
			if surface != expected || (surface != "cli" && surface != "app") {
				return fmt.Errorf("claim surface %q does not match installed surface %q", surface, expected)
			}
			session, _ := cmd.Flags().GetString("session")
			tmux, _ := cmd.Flags().GetString("tmux-session")
			if surface == "app" {
				if tmux != "" {
					return fmt.Errorf("--tmux-session cannot be used for an app claim")
				}
				if session == "" {
					session = strings.TrimSpace(a.env.Getenv("CODEX_THREAD_ID"))
				}
				if session == "" {
					return fmt.Errorf("app conversation cannot be identified; supply --session with its verified native thread ID and leave the task as a draft until claimed")
				}
			} else {
				if tmux == "" {
					tmux, err = a.claimTmuxSession()
					if err != nil {
						return fmt.Errorf("cannot identify existing terminal conversation: %w; leave the task as a draft or supply --tmux-session", err)
					}
				}
				if session == "" {
					_, session = a.harnessSessionFromEnv()
				}
			}
			id, err := a.canonicalFiberID(fiber.Path)
			if err != nil {
				return err
			}
			body, err := json.Marshal(map[string]any{"fiber_id": id, "surface": surface, "tmux_session": tmux, "session_uuid": session, "agent": block.Agent})
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
	claimCmd.Flags().String("surface", "", "Existing conversation surface: cli or app (must match installed task)")
	claimCmd.Flags().String("session", "", "Exact native conversation ID; app defaults to CODEX_THREAD_ID")
	claimCmd.Flags().String("tmux-session", "", "Existing tmux session name (otherwise detected from this pane)")
	return claimCmd
}
