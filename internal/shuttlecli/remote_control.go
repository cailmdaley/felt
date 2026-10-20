package shuttlecli

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/spf13/cobra"
)

func (a *app) remoteControlCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "remote-control",
		Short:   "Show the local daemon's Claude Remote Control host",
		GroupID: groupHosts,
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			endpoint, err := a.daemonEndpoint("/api/v1/remote_control")
			if err != nil {
				return err
			}
			body, err := a.getDaemon(endpoint, daemonReadTimeout)
			if err != nil {
				return err
			}
			var status struct {
				State         string   `json:"state"`
				Dir           string   `json:"dir"`
				Args          []string `json:"args"`
				PID           *int     `json:"pid"`
				StartedAt     string   `json:"started_at"`
				Restarts      int      `json:"restarts"`
				NextAttemptAt string   `json:"next_attempt_at"`
				Message       string   `json:"message"`
				LastExit      *struct {
					Status *int     `json:"status"`
					At     string   `json:"at"`
					Screen []string `json:"screen"`
				} `json:"last_exit"`
			}
			if err := json.Unmarshal(body, &status); err != nil {
				return fmt.Errorf("decoding Remote Control status: %w", err)
			}
			if a.json {
				a.printDaemonBody(body)
				return nil
			}
			fmt.Fprintf(a.env.Stdout, "Remote Control: %s\n", status.State)
			if status.Dir != "" {
				fmt.Fprintf(a.env.Stdout, "Directory: %s\n", status.Dir)
			}
			if len(status.Args) > 0 {
				encoded, _ := json.Marshal(status.Args)
				fmt.Fprintf(a.env.Stdout, "Arguments: %s\n", encoded)
			}
			if status.PID != nil {
				fmt.Fprintf(a.env.Stdout, "Pane PID: %d\n", *status.PID)
			}
			if status.StartedAt != "" {
				fmt.Fprintf(a.env.Stdout, "Started: %s\n", status.StartedAt)
			}
			fmt.Fprintf(a.env.Stdout, "Starts this daemon: %d\n", status.Restarts)
			if status.NextAttemptAt != "" {
				fmt.Fprintf(a.env.Stdout, "Next attempt: %s\n", status.NextAttemptAt)
			}
			if status.Message != "" {
				fmt.Fprintln(a.env.Stdout, status.Message)
			}
			if exit := status.LastExit; exit != nil {
				code := "unknown"
				if exit.Status != nil {
					code = fmt.Sprint(*exit.Status)
				}
				fmt.Fprintf(a.env.Stdout, "Last exit: %s at %s\n", code, exit.At)
				if len(exit.Screen) > 0 {
					fmt.Fprintln(a.env.Stdout, strings.Join(exit.Screen, "\n"))
				}
			}
			return nil
		},
	}
}
