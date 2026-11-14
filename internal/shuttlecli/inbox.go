package shuttlecli

import (
	"encoding/json"
	"fmt"
	"text/tabwriter"
	"time"

	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/spf13/cobra"
)

// inboxVerbs are the owner-local inbox verbs: put, pending and ls. An address
// is a fiber key or a session's shuttle:// address.
func (a *app) shuttleInboxCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "inbox",
		Short: "Enqueue and list the entries waiting in an address's inbox",
	}
	cmd.AddCommand(a.inboxVerbs()...)
	return cmd
}

func (a *app) inboxVerbs() []*cobra.Command {
	var wishes messaging.Wishes
	var from string
	var derived bool
	put := &cobra.Command{
		Use:   "put <address> <message-id> <text>",
		Short: "Enqueue an entry in an address's inbox on this host",
		Long: `Enqueue an entry in the inbox of a fiber key or a session's shuttle:// address
on this host. In a fiber's inbox, an id already there is a successful no-op
when its content and wishes match, or whatever they are with --derived;
otherwise it is a message_id_conflict. A session's inbox refuses an id already
pending, and a turn of force or idle. An unknown wish value is refused.`,
		Args: cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := messaging.ValidateSender(from); err != nil {
				return err
			}
			return messaging.Enqueue(a.env, messaging.InboxEntry{
				Address: args[0],
				Request: messaging.Request{MessageID: args[1], Text: args[2], From: from},
				Wishes:  wishes,
				Derived: derived,
			})
		},
	}
	put.Flags().StringVar(&wishes.Source, "source", "", "message, human, voice, thread, pulse or notice (default message)")
	put.Flags().StringVar(&wishes.Turn, "turn", "", "none, idle, ask or force (default none)")
	put.Flags().StringVar(&wishes.Session, "session", "", "any, fresh or previous (default any)")
	put.Flags().StringVar(&wishes.IfCostly, "if-costly", "", "hold or fresh (default fresh for a thread, else hold)")
	put.Flags().StringVar(&wishes.NotBefore, "not-before", "", "RFC 3339 time before which the entry stays pending")
	put.Flags().StringVar(&from, "from", "", "Sender named in the message header")
	put.Flags().BoolVar(&derived, "derived", false, "The id names the event it reports; the first capture wins")

	pending := &cobra.Command{
		Use:   "pending <address>...",
		Short: "Count each address's pending entries, as one JSON object",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return a.printPendingCounts(args)
		},
	}

	ls := &cobra.Command{
		Use:   "ls <address>",
		Short: "List an address's pending entries, oldest first",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			entries, err := messaging.PendingEntries(a.env, args[0])
			if err != nil {
				return err
			}
			if a.json {
				return json.NewEncoder(a.env.Stdout).Encode(entries)
			}
			w := tabwriter.NewWriter(a.env.Stdout, 0, 0, 2, ' ', 0)
			for _, e := range entries {
				notBefore, from := e.NotBefore, e.From
				if notBefore == "" {
					notBefore = "-"
				}
				if from == "" {
					from = "-"
				}
				fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\n", e.MessageID, e.Source, e.Turn, notBefore, e.QueuedAt.UTC().Format(time.RFC3339), from)
			}
			return w.Flush()
		},
	}
	return []*cobra.Command{put, pending, ls}
}

// printPendingCounts prints one JSON object, key => pending count. A key
// whose inbox cannot be read names itself on stderr and is left out, so the
// others still count.
func (a *app) printPendingCounts(keys []string) error {
	if err := messaging.PruneOfferedMailboxes(a.env, time.Now()); err != nil {
		return err
	}
	counts := make(map[string]int, len(keys))
	for _, key := range keys {
		n, err := messaging.PendingCount(a.env, key)
		if err != nil {
			fmt.Fprintf(a.env.Stderr, "%s: %v\n", key, err)
			continue
		}
		counts[key] = n
	}
	return json.NewEncoder(a.env.Stdout).Encode(counts)
}
