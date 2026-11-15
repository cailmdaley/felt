package shuttlecli

import (
	"encoding/json"
	"io"

	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/spf13/cobra"
)

// humanInboxVerbs records the human's typed lines. The text comes on stdin,
// so a line beginning with "-" is never read as a flag and a long paste is
// not bounded by the argument list.

func (a *app) humanInboxVerbs() []*cobra.Command {
	begin := &cobra.Command{Use: "human-begin <fiber-key> <message-id> < text", Short: "Record typed human input, read from stdin, before submission", Args: cobra.ExactArgs(2), RunE: func(cmd *cobra.Command, args []string) error {
		text, err := io.ReadAll(a.env.Stdin)
		if err != nil {
			return err
		}
		created, err := messaging.BeginHuman(a.env, args[0], args[1], string(text))
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
