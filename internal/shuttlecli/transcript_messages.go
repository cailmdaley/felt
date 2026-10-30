package shuttlecli

import (
	"fmt"

	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/spf13/cobra"
)

func (a *app) transcriptMessagesCmd() *cobra.Command {
	return &cobra.Command{
		Use: "messages <session-id>", Short: "Read host-local message envelope evidence for a conversation",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if !sessionUUIDPattern.MatchString(args[0]) {
				return fmt.Errorf("invalid session ID %q: expected a UUID", args[0])
			}
			messages, err := messaging.DeliveredEnvelopes(a.env, args[0])
			if err != nil {
				return err
			}
			return a.outputJSON(struct {
				Messages []messaging.DeliveredEnvelope `json:"messages"`
			}{messages})
		},
	}
}
