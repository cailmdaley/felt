package shuttlecli

import (
	"fmt"
	"strconv"
	"time"

	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/spf13/cobra"
)

func (a *app) transcriptMessagesCmd() *cobra.Command {
	var since string
	cmd := &cobra.Command{
		Use: "messages <session-id>", Short: "Read host-local message envelope evidence for a conversation",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if !sessionUUIDPattern.MatchString(args[0]) {
				return fmt.Errorf("invalid session ID %q: expected a UUID", args[0])
			}
			var watermark time.Time
			if since != "" {
				nanos, err := strconv.ParseInt(since, 10, 64)
				if err != nil || nanos < 0 {
					return fmt.Errorf("invalid envelope cursor")
				}
				watermark = time.Unix(0, nanos)
			}
			cursor := strconv.FormatInt(time.Now().Add(-2*time.Minute).UnixNano(), 10)
			messages, err := messaging.DeliveredEnvelopesSince(a.env, args[0], watermark)
			if err != nil {
				return err
			}
			return a.outputJSON(struct {
				Messages []messaging.DeliveredEnvelope `json:"messages"`
				Cursor   string                        `json:"cursor"`
			}{messages, cursor})
		},
	}
	cmd.Flags().StringVar(&since, "since", "", "read envelope changes after this cursor")
	return cmd
}
