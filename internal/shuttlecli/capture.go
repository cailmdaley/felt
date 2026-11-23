package shuttlecli

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/spf13/cobra"
)

func (a *app) captureCmd() *cobra.Command {
	var projectDir, host, agent, effort string
	var chrome bool
	cmd := &cobra.Command{
		Use:   "capture <prompt>",
		Short: "Launch an agent from a prompt; it files and claims its own fiber",
		Long: `Start a worker in --project-dir from a prompt alone. No fiber exists yet: the
agent files its constitution and claims it. To run a fiber that exists, use
dispatch.

--host launches on another host through the local daemon; --project-dir is then
a directory there. --agent and --effort default to the registry's choices.
--json prints the daemon's answer.`,
		Example: `  shuttle capture "Find out why the mocks drift" --project-dir "$PWD"`,
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if strings.TrimSpace(args[0]) == "" {
				return errors.New("prompt must not be empty")
			}
			// Errors that quote the command leave the prompt out.
			quoted := []string{"[prompt omitted]"}
			own, err := a.resolveOwnHost("")
			if err != nil {
				return err
			}
			target := strings.TrimSpace(host)
			if target == "" {
				target = own
			}
			owner, err := a.routeOwnerForCommand(cmd, quoted, target)
			if err != nil {
				return err
			}
			dir, err := a.captureProjectDir(owner, projectDir)
			if err != nil {
				return err
			}
			payload := map[string]any{"prompt": args[0], "project_dir": dir, "origin": target}
			if agent != "" {
				payload["agent"] = agent
			}
			if effort != "" {
				payload["effort"] = effort
			}
			if chrome {
				payload["chrome"] = true
			}
			body, err := a.postToOwner(cmd, quoted, owner, "/api/v1/capture", payload)
			if err != nil {
				return err
			}
			if a.json {
				a.printDaemonBody(body)
				return nil
			}
			var reply struct {
				Agent       string `json:"agent"`
				TmuxSession string `json:"tmux_session"`
				SessionUUID string `json:"session_uuid"`
			}
			if err := json.Unmarshal(body, &reply); err != nil {
				return fmt.Errorf("parsing capture response: %w", err)
			}
			fmt.Fprintf(a.env.Stdout, "launched %s on %s in %s\n", reply.Agent, target, dir)
			fmt.Fprintf(a.env.Stdout, "  terminal: %s\n", reply.TmuxSession)
			if reply.SessionUUID != "" {
				fmt.Fprintf(a.env.Stdout, "  session: %s\n", reply.SessionUUID)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&projectDir, "project-dir", "", "Directory the worker starts in, on the launching host (required)")
	cmd.Flags().StringVar(&host, "host", "", "Host to launch on (default: this host)")
	cmd.Flags().StringVar(&agent, "agent", "", "Agent registry id (default: the registry's)")
	cmd.Flags().StringVar(&effort, "effort", "", "Effort level (default: the agent's)")
	cmd.Flags().BoolVar(&chrome, "chrome", false, "Launch with the browser enabled")
	_ = cmd.MarkFlagRequired("project-dir")
	return cmd
}

// captureProjectDir is the directory raw names on owner ("" for this host). An
// owner too old to resolve one is sent raw, and checks it at launch.
func (a *app) captureProjectDir(owner, raw string) (string, error) {
	if owner == "" {
		return a.resolveProjectDirFlag(raw)
	}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("--project-dir is required")
	}
	dir, err := a.resolveOwnerProjectDir(owner, raw)
	var status daemonStatusError
	if errors.As(err, &status) && status.status == 404 {
		return raw, nil
	}
	if err != nil {
		return "", fmt.Errorf("resolving --project-dir on %q: %w; nothing was launched", owner, err)
	}
	return dir, nil
}
