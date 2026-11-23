package shuttlecli

import (
	"encoding/json"
	"fmt"

	"github.com/spf13/cobra"
)

func (a *app) killCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "kill <fiber>",
		Short: "Stop a fiber's worker without changing its lifecycle",
		Long: `Stop the fiber's live worker through the daemon that owns it. It writes no
status, outcome or verdict: a fiber that is still active stays armed, so its
daemon may launch a fresh worker. Use rest or close to settle it instead.

The fiber resolves from any directory and must match exactly. A fiber with no
worker is reported and is not an error. --json prints the daemon's answer,
{fiber_id, killed, session}.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			fiber, err := a.resolveOwnedFiber(args[0])
			if err != nil {
				return err
			}
			owner, err := a.routeOwnerForCommand(cmd, args, fiber.Host)
			if err != nil {
				return err
			}
			body, err := a.postToOwner(cmd, args, owner, "/api/v1/kill", map[string]any{
				"fiber_id": fiber.UID, "origin": fiber.Host,
			})
			if err != nil {
				return err
			}
			if a.json {
				a.printDaemonBody(body)
				return nil
			}
			var reply struct {
				Killed  bool   `json:"killed"`
				Session string `json:"session"`
			}
			if err := json.Unmarshal(body, &reply); err != nil {
				return fmt.Errorf("parsing kill response: %w", err)
			}
			if !reply.Killed {
				fmt.Fprintf(a.env.Stdout, "%s has no live worker on %s\n", fiber.ID, fiber.Host)
				return nil
			}
			fmt.Fprintf(a.env.Stdout, "killed %s (%s on %s)\n", reply.Session, fiber.ID, fiber.Host)
			return nil
		},
	}
}

// postToOwner posts payload to path on the local daemon, which routes it by
// the payload's origin; owner is routeOwnerForCommand's answer, "" for this
// host. args name the action in an error's advice.
func (a *app) postToOwner(cmd *cobra.Command, args []string, owner, path string, payload map[string]any) ([]byte, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	endpoint, err := a.daemonEndpoint(path)
	if err != nil {
		return nil, err
	}
	if owner == "" {
		return a.postDaemon(endpoint, body, daemonPostTimeout)
	}
	reply, err := a.postRouted(owner, endpoint, body)
	if err != nil {
		return nil, remoteRouteError(cmd, args, owner, err)
	}
	return reply, nil
}
