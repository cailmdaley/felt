package shuttlecli

import (
	"encoding/json"
	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/spf13/cobra"
)

func (a *app) humanInboxVerbs() []*cobra.Command {
	begin := &cobra.Command{Use: "human-begin <fiber-key> <message-id> <text>", Short: "Record typed human input before submission", Args: cobra.ExactArgs(3), RunE: func(cmd *cobra.Command, args []string) error {
		created, err := messaging.BeginHuman(a.env, args[0], args[1], args[2])
		if err != nil {
			return err
		}
		return json.NewEncoder(a.env.Stdout).Encode(map[string]bool{"created": created})
	}}
	settle := &cobra.Command{Use: "human-settle <fiber-key> <message-id> delivered|unknown|undeliverable", Short: "Record the outcome of typed human input", Args: cobra.ExactArgs(3), RunE: func(cmd *cobra.Command, args []string) error {
		return messaging.SettleHuman(a.env, args[0], args[1], args[2])
	}}
	return []*cobra.Command{begin, settle}
}
