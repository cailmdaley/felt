package shuttlecli

import (
	"context"
	"encoding/json"
	"time"

	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/spf13/cobra"
)

func (a *app) claudeMailRecoverCmd() *cobra.Command {
	return &cobra.Command{
		Use: "claude-mail-recover", Hidden: true, Args: cobra.NoArgs,
		Short: "Wake Claude for automatic mail not offered by a main-thread hook",
		RunE: func(cmd *cobra.Command, _ []string) error {
			host, err := a.resolveOwnHost("")
			if err != nil {
				return err
			}
			pending, err := messaging.RecoverClaudeMail(cmd.Context(), a.env, host, time.Now(), func(ctx context.Context, request messaging.Request) error {
				receipt, err := a.postMessageContext(ctx, request)
				return messageReceiptError(request.MessageID, receipt, err)
			})
			result := struct {
				Pending bool   `json:"pending"`
				Error   string `json:"error,omitempty"`
			}{Pending: pending}
			if err != nil {
				result.Error = err.Error()
			}
			return json.NewEncoder(a.env.Stdout).Encode(result)
		},
	}
}
