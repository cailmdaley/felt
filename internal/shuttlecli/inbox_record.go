package shuttlecli

import (
	"encoding/json"
	"io"

	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/spf13/cobra"
)

// recordInboxVerbs record the lines the daemon transports itself (typed human
// input, an agent's fresh session request). The text comes on stdin, so a
// line beginning with "-" is never read as a flag and a long paste is not
// bounded by the argument list.
func (a *app) recordInboxVerbs() []*cobra.Command {
	var from string
	begin := &cobra.Command{Use: "record-begin <fiber-key> <message-id> < text", Short: "Record a line, read from stdin, before the daemon transports it", Args: cobra.ExactArgs(2), RunE: func(cmd *cobra.Command, args []string) error {
		text, err := io.ReadAll(a.env.Stdin)
		if err != nil {
			return err
		}
		created, disposition, err := messaging.BeginRecord(a.env, args[0], args[1], from, string(text))
		if err != nil {
			return err
		}
		return json.NewEncoder(a.env.Stdout).Encode(map[string]any{"created": created, "disposition": disposition})
	}}
	begin.Flags().StringVar(&from, "from", "human", "who the line is from")
	settle := &cobra.Command{Use: "record-settle <fiber-key> <message-id> delivered|unknown|undeliverable", Short: "Record the outcome of a recorded line's transport", Args: cobra.ExactArgs(3), RunE: func(cmd *cobra.Command, args []string) error {
		return messaging.SettleRecord(a.env, args[0], args[1], args[2])
	}}
	return []*cobra.Command{begin, settle}
}
