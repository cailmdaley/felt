package shuttlecli

import (
	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/spf13/cobra"
	"time"
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
			return messaging.RecoverClaudeMail(cmd.Context(), a.env, host, time.Now())
		},
	}
}
