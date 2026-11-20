package shuttlecli

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"text/tabwriter"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/cailmdaley/felt/internal/sysenv"
	"github.com/spf13/cobra"
)

// inboxVerbs are the inbox verbs: put, pending, ls, cancel, consume and
// rekey. An address is a fiber key (fiber:<uid>) or a session's shuttle://
// address on this host; ls and cancel also take a fiber reference, answered
// by the fiber's owner.
func (a *app) shuttleInboxCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "inbox",
		Short: "Enqueue and list the entries waiting in an address's inbox",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return fmt.Errorf("expected put, pending, ls, cancel or consume")
		},
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
on this host. A fiber's key is fiber: and its uid (fiber:01M7...), naming no
store, so the inbox stays put when the fiber's tree moves to another store; a
fiber without a uid is keyed by its store's path and its id, joined by a colon.
The daemon reads no other key for that fiber.
In a fiber's inbox, an id already there is a successful no-op
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
	put.Flags().StringVar(&wishes.Source, "source", "", "message, human, voice, thread or pulse (default message)")
	put.Flags().StringVar(&wishes.Turn, "turn", "", "none, idle, ask or force (default none)")
	put.Flags().StringVar(&wishes.IfCostly, "if-costly", "", "hold or fresh (default fresh for a thread, else hold)")
	put.Flags().StringVar(&wishes.NotBefore, "not-before", "", "RFC 3339 time before which the entry stays pending")
	put.Flags().StringVar(&from, "from", "", "Sender named in the message header")
	put.Flags().BoolVar(&derived, "derived", false, "The id names the event it reports; the first capture wins")

	var waking bool
	pending := &cobra.Command{
		Use:   "pending <address>...",
		Short: "Summarize each address's pending entries, as one JSON object",
		Long: `Summarize each address's pending entries, as one JSON object of address to
{count, scheduled}: count is the entries due now, scheduled every entry with a
delivery time (not_before), overdue ones included. With --waking, count only the due entries that ask for a turn, free or held by
an open batch, and count none while a launch reserved in its lease still owes
one: the entries a session started for a fiber with no worker would be started
for.`,
		Args: cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if waking {
				return a.printCounts(args, messaging.WakingCount)
			}
			return a.printPendingSummaries(args)
		},
	}
	pending.Flags().BoolVar(&waking, "waking", false, "Count only due entries that would start a session")

	var scheduled bool
	ls := &cobra.Command{
		Use:   "ls <fiber-or-key>",
		Short: "List an address's pending entries, oldest first",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			entries, err := a.listInbox(args[0], scheduled)
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
				fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", e.MessageID, e.Source, e.Turn, notBefore, e.QueuedAt.UTC().Format(time.RFC3339), from, e.Text, e.Waiting)
			}
			return w.Flush()
		},
	}
	ls.Flags().BoolVar(&scheduled, "scheduled", false, "Only pending entries with a delivery time, including overdue entries")
	cancel := &cobra.Command{
		Use:   "cancel <fiber-or-key> <message-id>",
		Short: "Cancel a pending entry, so it is never delivered",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return a.cancelInbox(args[0], args[1])
		},
	}
	var idle, unknown, costly, busy bool
	var message string
	consume := &cobra.Command{
		Use:   "consume <fiber-key> <address-or-dash> <epoch>",
		Short: "Consume a fiber's inbox for its worker, as one JSON answer",
		Long: `Consume a fiber's inbox for its live conversation: advance every open batch,
then wake, send quiet context to a receiver without a hook, reserve a fresh
launch or wait. A worker whose conversation is not yet known (- with its
epoch) waits. For a fiber with no worker, pass - and epoch 0: a due entry
that asks for a turn reserves a launch ("action": "launch") once per two-minute
lease (answering wait with "launching": true while the lease stands), and the
session launched for it takes the entries through its hook.
The JSON answer is printed whenever consume decided, including when an open
batch's delivery failed, which then exits nonzero; "turn": true asks the caller
to consume again with the worker's --idle, --unknown and --costly facts.`,
		Args: cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			host, err := a.resolveOwnHost("")
			if err != nil {
				return err
			}
			epoch, err := strconv.ParseUint(args[2], 10, 64)
			if err != nil || (epoch == 0 && args[1] != "-") {
				return fmt.Errorf("a positive receiver epoch required, or - with epoch 0 for a fiber with no worker")
			}
			result, err := messaging.Consume(context.Background(), a.env, args[0], host, messaging.Worker{Address: args[1], Epoch: epoch, Idle: idle || unknown, Unknown: unknown, Costly: costly, Busy: busy, Message: message})
			if result.Action == "" {
				return err
			}
			if encodeErr := json.NewEncoder(a.env.Stdout).Encode(result); encodeErr != nil {
				return encodeErr
			}
			return err
		},
	}
	consume.Flags().BoolVar(&busy, "busy", false, "The live worker is in a turn; use its follow-up transport")
	consume.Flags().StringVar(&message, "message", "", "Report this entry's state after the pass: delivered, sent, reserved, pending or unknown")
	consume.Flags().BoolVar(&idle, "idle", false, "The live worker was observed idle")
	consume.Flags().BoolVar(&unknown, "unknown", false, "The live worker's turn state is unknown: woken for ask, never for idle")
	consume.Flags().BoolVar(&costly, "costly", false, "Waking the live worker is costly")
	rekey := &cobra.Command{
		Use:   "rekey <store>...",
		Short: "Move inboxes keyed by a store's path to their fiber's uid key",
		Long: `Move the inbox of every Shuttle-managed fiber in these felt stores that is
still keyed <store>:<uid>, for any of the stores, to fiber:<uid>, and point
session links at it. Every store is tried for every fiber's uid, so an inbox
left under the store a tree moved out of is found too. When several such
inboxes exist for one fiber, the one whose receiver was written last becomes
the inbox and the others add the entries it lacks. Idempotent; the daemon runs
it at boot. A store that cannot be listed is named on stderr and skipped.
Prints the number of inboxes moved.`,
		Args: cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var uids []string
			for _, store := range args {
				fibers, err := felt.NewStorage(store).ListMetadataHavingFrontmatterFields([]string{"shuttle"})
				if err != nil {
					fmt.Fprintf(a.env.Stderr, "%s: %v\n", store, err)
					continue
				}
				for _, f := range fibers {
					uids = append(uids, f.UID)
				}
			}
			n, err := messaging.RekeyFiberInboxes(a.env, args, uids)
			fmt.Fprintln(a.env.Stdout, n)
			return err
		},
	}
	return append(append([]*cobra.Command{put, pending, ls, consume, cancel, rekey}, a.recordInboxVerbs()...), a.threadInboxVerbs()...)
}

// printPendingSummaries prints one JSON object, key => its PendingSummary. A key
// whose inbox cannot be read names itself on stderr and is left out, so the
// others still count.
func (a *app) printPendingSummaries(keys []string) error {
	if err := messaging.PruneOfferedMailboxes(a.env, time.Now()); err != nil {
		return err
	}
	summaries := make(map[string]messaging.PendingSummary, len(keys))
	for _, key := range keys {
		summary, err := messaging.SummarizePending(a.env, key)
		if err != nil {
			fmt.Fprintf(a.env.Stderr, "%s: %v\n", key, err)
			continue
		}
		summaries[key] = summary
	}
	return json.NewEncoder(a.env.Stdout).Encode(summaries)
}

// printCounts prints one JSON object, key => count. A key whose inbox cannot
// be read names itself on stderr and is left out, so the others still count.
func (a *app) printCounts(keys []string, count func(*sysenv.Env, string) (int, error)) error {
	counts := make(map[string]int, len(keys))
	for _, key := range keys {
		n, err := count(a.env, key)
		if err != nil {
			fmt.Fprintf(a.env.Stderr, "%s: %v\n", key, err)
			continue
		}
		counts[key] = n
	}
	return json.NewEncoder(a.env.Stdout).Encode(counts)
}
