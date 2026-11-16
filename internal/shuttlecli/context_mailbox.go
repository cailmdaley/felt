package shuttlecli

import (
	"encoding/json"
	"fmt"
	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/spf13/cobra"
)

func (a *app) contextMailboxCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "context-mailbox", Hidden: true, Short: "Owner-local durable fiber context"}
	var wake bool
	var turn, notBefore, ifCostly string
	var derived, attachmentsStdin bool
	var from string
	var threadSignal string
	var retainedAt string
	var replyTo string
	var notifyAddress string
	var notifyWhenIdle bool
	var notifyWake bool
	put := &cobra.Command{Use: "put <fiber-key> <message-id> <text>", Args: cobra.ExactArgs(3), RunE: func(cmd *cobra.Command, args []string) error {
		if err := messaging.ValidateSender(from); err != nil {
			return err
		}
		request := messaging.Request{
			MessageID: args[1], Text: args[2], From: from,
			RetainedAt: retainedAt,
			Wake:       wake, ReplyTo: replyTo, NotifyAddress: notifyAddress,
			NotifyWhenIdle: notifyWhenIdle, NotifyWake: notifyWake,
		}
		if attachmentsStdin {
			if err := json.NewDecoder(a.env.Stdin).Decode(&request.Attachments); err != nil {
				return err
			}
		}
		if threadSignal != "" {
			var signal messaging.ThreadSignal
			if err := json.Unmarshal([]byte(threadSignal), &signal); err != nil {
				return fmt.Errorf("parsing thread signal: %w", err)
			}
			request.ThreadSignal = &signal
		}
		return messaging.Enqueue(a.env, messaging.InboxEntry{Address: args[0], Request: request, Wishes: messaging.Wishes{Turn: turn, NotBefore: notBefore, IfCostly: ifCostly}, Derived: derived})
	}}
	put.Flags().BoolVar(&attachmentsStdin, "attachments-stdin", false, "Read attachment publications as JSON from stdin")
	put.Flags().StringVar(&notBefore, "not-before", "", "Earliest delivery instant, RFC 3339")
	put.Flags().StringVar(&ifCostly, "if-costly", "", "hold or fresh")
	put.Flags().StringVar(&turn, "turn", "", "none, idle, ask or force")
	put.Flags().BoolVar(&derived, "derived", false, "The id names the event it reports; the first capture wins")
	put.Flags().BoolVar(&wake, "wake", false, "Start a turn in the live orchestrator")
	put.Flags().StringVar(&from, "from", "", "Sender named in the message header")
	put.Flags().StringVar(&replyTo, "reply-to", "", "Fiber reply target")
	put.Flags().StringVar(&notifyAddress, "notify-address", "", "Idle callback address")
	put.Flags().BoolVar(&notifyWhenIdle, "notify-when-idle", false, "Subscribe for idle notification")
	put.Flags().BoolVar(&notifyWake, "notify-wake", false, "Wake on an idle notification")
	put.Flags().StringVar(&threadSignal, "thread-signal", "", "Thread lifecycle signal JSON for delivery-time validation")
	put.Flags().StringVar(&retainedAt, "retained-at", "", "Origin timestamp used to expire replayed thread context")
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
