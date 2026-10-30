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
	var from string
	var threadSignal string
	put := &cobra.Command{Use: "put <fiber-key> <message-id> <text>", Args: cobra.ExactArgs(3), RunE: func(cmd *cobra.Command, args []string) error {
		request := messaging.Request{MessageID: args[1], Text: args[2], From: from, Wake: wake}
		if threadSignal != "" {
			var signal messaging.ThreadSignal
			if err := json.Unmarshal([]byte(threadSignal), &signal); err != nil {
				return fmt.Errorf("parsing thread signal: %w", err)
			}
			request.ThreadSignal = &signal
		}
		return messaging.QueueFiberContext(a.env, args[0], request)
	}}
	put.Flags().BoolVar(&wake, "wake", false, "Start a turn in the live orchestrator")
	put.Flags().StringVar(&from, "from", "shuttle", "Sender label the receiving worker sees")
	put.Flags().StringVar(&threadSignal, "thread-signal", "", "Thread lifecycle signal JSON for delivery-time validation")
	cmd.AddCommand(put)
	cmd.AddCommand(&cobra.Command{Use: "pending <fiber-key>...", Args: cobra.MinimumNArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		// One JSON object, key => count. A key whose mailbox cannot be read
		// names itself on stderr and is left out, so the others still count.
		counts := make(map[string]int, len(args))
		for _, key := range args {
			n, err := messaging.PendingFiberContext(a.env, key)
			if err != nil {
				fmt.Fprintf(a.env.Stderr, "%s: %v\n", key, err)
				continue
			}
			counts[key] = n
		}
		return json.NewEncoder(a.env.Stdout).Encode(counts)
	}})
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
	var existing bool
	revoke := &cobra.Command{Use: "revoke <fiber-key>...", Args: cobra.MinimumNArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		host, err := a.resolveOwnHost("")
		if err != nil {
			return err
		}
		// Each key is revoked independently: one corrupt record names itself
		// on stderr without withholding revocation from the others.
		failed := 0
		for _, key := range args {
			if existing {
				_, err = messaging.RevokeExistingFiberReceiver(a.env, key, host)
			} else {
				_, err = messaging.TransitionFiberReceiver(a.env, key, host, "", "-")
			}
			if err != nil {
				failed++
				fmt.Fprintf(a.env.Stderr, "%s: %v\n", key, err)
			}
		}
		if failed > 0 {
			return fmt.Errorf("%d of %d receivers not revoked", failed, len(args))
		}
		return nil
	}}
	revoke.Flags().BoolVar(&existing, "existing", false, "Revoke only fibers that already have a mailbox; create nothing")
	cmd.AddCommand(revoke)
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

func (a *app) threadSignalCurrentCmd() *cobra.Command {
	return &cobra.Command{Use: "thread-signal-current <request-json>", Hidden: true, Args: cobra.ExactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		var request messaging.ThreadSignalCheck
		if err := json.Unmarshal([]byte(args[0]), &request); err != nil {
			return fmt.Errorf("parsing thread signal check: %w", err)
		}
		payload, err := json.Marshal(request)
		if err != nil {
			return fmt.Errorf("encoding thread signal check: %w", err)
		}
		endpoint, err := a.daemonEndpoint("/api/v1/thread-signals/current")
		if err != nil {
			return err
		}
		body, err := a.postDaemon(endpoint, payload, daemonPostTimeout)
		if err != nil {
			return err
		}
		_, err = a.env.Stdout.Write(append(body, '\n'))
		return err
	}}
}
