package shuttlecli

import (
	"context"
	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/spf13/cobra"
)

func (a *app) contextMailboxCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "context-mailbox", Hidden: true, Short: "Owner-local durable fiber context"}
	var wake bool
	put := &cobra.Command{Use: "put <fiber-key> <message-id> <text>", Args: cobra.ExactArgs(3), RunE: func(cmd *cobra.Command, args []string) error {
		return messaging.QueueFiberContext(a.env, args[0], messaging.Request{MessageID: args[1], Text: args[2], From: "shuttle", Wake: wake})
	}}
	put.Flags().BoolVar(&wake, "wake", false, "Start a turn in the live orchestrator")
	cmd.AddCommand(put)
	cmd.AddCommand(&cobra.Command{Use: "deliver <fiber-key> <address>", Args: cobra.ExactArgs(2), RunE: func(cmd *cobra.Command, args []string) error {
		host, err := a.resolveOwnHost("")
		if err != nil {
			return err
		}
		return messaging.DeliverFiberContext(context.Background(), a.env, args[0], host, args[1])
	}})
	return cmd
}
