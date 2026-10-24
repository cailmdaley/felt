package shuttlecli

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

// migrationUnconfirmed means the daemon may have committed the move even though
// its acknowledgment did not reach the caller. Never call the child disabled then.
type migrationUnconfirmed struct{ err error }

func (e migrationUnconfirmed) Error() string { return e.err.Error() }
func (e migrationUnconfirmed) Unwrap() error { return e.err }

func (a *app) migrateCmd() *cobra.Command {
	var from string
	var rest, disabled bool
	cmd := &cobra.Command{
		Use:   "migrate <to-fiber>",
		Short: "Move your live conversation to another installed fiber without ending it",
		Long: `Move a live worker on this host to another installed fiber with no live worker.
The owning daemon moves its assignment, watcher and session identity without
copying conversation context or ending the process. The source stays active
and gets a fresh worker from its Status; --rest puts it in Resting instead,
and --disabled leaves it open in Drafts.

The source is inferred from your current session or tmux pane, then the dispatch
path. --from overrides it. A retry with the same session and destination succeeds
without a second move. Both fibers must belong to this host.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if rest && disabled {
				return fmt.Errorf("--rest and --disabled are incompatible")
			}
			var source *felt.Felt
			var err error
			if from != "" {
				source, err = a.shuttleAddressFiber(from)
			} else {
				source, err = a.currentWorkerFiber()
			}
			if err != nil {
				return fmt.Errorf("cannot identify source worker; pass --from <fiber>: %w", err)
			}
			target, err := a.shuttleAddressFiber(args[0])
			if err != nil {
				return err
			}
			response, err := a.migrateWorker(cmd, source, target, rest, disabled)
			if err != nil {
				return err
			}
			if a.json {
				var result any
				if err := json.Unmarshal(response, &result); err != nil {
					return err
				}
				return a.outputJSON(result)
			}
			fmt.Fprintf(a.env.Stdout, "Moved session from %s to %s.\n", source.ID, target.ID)
			return nil
		},
	}
	cmd.Flags().StringVar(&from, "from", "", "Source fiber (default: current worker assignment)")
	cmd.Flags().BoolVar(&rest, "rest", false, "Leave the source resting instead of launching a fresh worker")
	cmd.Flags().BoolVar(&disabled, "disabled", false, "Leave the source open in Drafts instead of launching a fresh worker")
	return cmd
}

func (a *app) migrateWorker(cmd *cobra.Command, source, target *felt.Felt, rest, disabled bool) ([]byte, error) {
	own, err := a.resolveOwnHost("")
	if err != nil {
		return nil, err
	}
	for _, fiber := range []*felt.Felt{source, target} {
		block, installed, err := shuttle.BlockOf(fiber)
		if err != nil {
			return nil, err
		}
		if !installed {
			return nil, fmt.Errorf("not_installed: install %s with shuttle install %s --disabled first", fiber.ID, fiber.ID)
		}
		if block.Host != own {
			return nil, fmt.Errorf("other_host: %s belongs to %q; migrate on its owning host (this host is %q)", fiber.ID, block.Host, own)
		}
	}
	from, err := a.canonicalFiberID(source.Path)
	if err != nil {
		return nil, err
	}
	to, err := a.canonicalFiberID(target.Path)
	if err != nil {
		return nil, err
	}
	harness, session := a.harnessSessionFromEnv()
	pane := strings.TrimSpace(a.env.Getenv("TMUX_PANE"))
	if a.env.Getenv("TMUX") == "" || (harness == "codex" && session != "") {
		// App Server tools can inherit a pane belonging to another conversation.
		pane = ""
	}
	body, err := json.Marshal(map[string]any{"from": from, "to": to, "session_id": session, "tmux_pane": pane, "rest": rest, "disabled": disabled})
	if err != nil {
		return nil, err
	}
	endpoint, err := a.daemonEndpoint("/api/v1/migrate")
	if err != nil {
		return nil, err
	}
	response, err := a.postDaemonContext(cmd.Context(), endpoint, body, daemonPostTimeout)
	if err != nil {
		var status daemonStatusError
		if errors.As(err, &status) && status.status >= 400 && status.status < 500 {
			var refusal struct {
				Reason string `json:"reason"`
			}
			if json.Unmarshal([]byte(status.body), &refusal) == nil && refusal.Reason != "" && refusal.Reason != "rollback_failed" {
				return nil, err
			}
		}
		return nil, migrationUnconfirmed{fmt.Errorf("migration not confirmed; inspect the current assignment before retrying: %w", err)}
	}
	var result struct {
		OK     bool   `json:"ok"`
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal(response, &result); err != nil {
		return nil, migrationUnconfirmed{fmt.Errorf("migration response unreadable; inspect the current assignment: %w", err)}
	}
	if !result.OK {
		if result.Reason == "rollback_failed" || result.Reason == "" {
			return nil, migrationUnconfirmed{fmt.Errorf("migration not confirmed; inspect the current assignment: %s", response)}
		}
		return nil, fmt.Errorf("migration rejected: %s", response)
	}
	return response, nil
}
