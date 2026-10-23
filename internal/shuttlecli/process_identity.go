package shuttlecli

import (
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/spf13/cobra"
)

func (a *app) processIdentityCmd() *cobra.Command {
	return &cobra.Command{
		Use:    "process-identity PID",
		Short:  "Observe a process lifetime as JSON (daemon-facing)",
		Hidden: true,
		Args:   cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			pid, err := strconv.Atoi(args[0])
			if err != nil || pid <= 0 {
				return fmt.Errorf("PID must be a positive integer")
			}
			return json.NewEncoder(a.env.Stdout).Encode(messaging.ProbeProcessIdentity(pid))
		},
	}
}
