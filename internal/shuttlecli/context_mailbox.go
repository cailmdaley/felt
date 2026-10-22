package shuttlecli

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/spf13/cobra"
	"strconv"
)

func (a *app) contextMailboxCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "context-mailbox", Hidden: true, Short: "Owner-local durable fiber context"}
	var wake bool
	put := &cobra.Command{Use: "put <fiber-key> <message-id> <text>", Args: cobra.ExactArgs(3), RunE: func(cmd *cobra.Command, args []string) error {
		return messaging.QueueFiberContext(a.env, args[0], messaging.Request{MessageID: args[1], Text: args[2], From: "shuttle", Wake: wake})
	}}
	put.Flags().BoolVar(&wake, "wake", false, "Start a turn in the live orchestrator")
	cmd.AddCommand(put)
	cmd.AddCommand(&cobra.Command{Use: "get <fiber-key>", Args: cobra.ExactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		receiver, err := messaging.ReadFiberReceiver(a.env, args[0])
		if err != nil {
			return err
		}
		return json.NewEncoder(a.env.Stdout).Encode(receiver)
	}})
	cmd.AddCommand(&cobra.Command{Use: "receiver <fiber-key> <worker-identity> <address-or-dash>", Args: cobra.ExactArgs(3), RunE: func(cmd *cobra.Command, args []string) error {
		host, err := a.resolveOwnHost("")
		if err != nil {
			return err
		}
		n, err := messaging.TransitionFiberReceiver(a.env, args[0], host, args[1], args[2])
		if err == nil {
			fmt.Fprintln(a.env.Stdout, n)
		}
		return err
	}})
	cmd.AddCommand(&cobra.Command{Use: "deliver <fiber-key> <address-or-dash> <generation>", Args: cobra.ExactArgs(3), RunE: func(cmd *cobra.Command, args []string) error {
		host, err := a.resolveOwnHost("")
		if err != nil {
			return err
		}
		generation, err := strconv.ParseUint(args[2], 10, 64)
		if err != nil || generation == 0 {
			return fmt.Errorf("positive receiver generation required")
		}
		return messaging.DeliverFiberContext(context.Background(), a.env, args[0], host, args[1], generation)
	}})
	return cmd
}
