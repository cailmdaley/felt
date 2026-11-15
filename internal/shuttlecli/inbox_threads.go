package shuttlecli

import (
	"encoding/json"
	"io"

	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/spf13/cobra"
)

// exitCorrupt is thread-state's exit status for a corrupt outbox or state,
// the one import failure the daemon holds boot for.
const exitCorrupt = 3

// threadInboxVerbs are the daemon's verbs for the routing inbox
// (messaging.ThreadRoutingAddress).
func (a *app) threadInboxVerbs() []*cobra.Command {
	state := &cobra.Command{
		Use:   "thread-state",
		Short: "Import an older daemon's thread outbox and print the capture window",
		Long: `Establish the thread capture baseline and import a thread-outbox left by
an older daemon into the routing inbox. Prints
{"baseline", "skipped", "cleanup_error"}: pending records the routing inbox
can never accept are skipped, and a cleanup failure leaves the imported outbox
for the next boot to remove. Exits 3 when the outbox's baseline or a pending
payload, or the state, is corrupt, leaving it untouched.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			report, err := messaging.BootThreadInbox(a.env)
			if messaging.ErrorCode(err) == "corrupt" {
				return &cliExitError{code: exitCorrupt, err: err}
			}
			if err != nil {
				return err
			}
			return json.NewEncoder(a.env.Stdout).Encode(report)
		},
	}
	capture := &cobra.Command{
		Use:   "thread-put",
		Short: "Capture thread publications into the routing inbox",
		Long: `Read a JSON array of {"id", "record"} thread publications on stdin and
enqueue each into the routing inbox. Prints {"created": [ids], "refused":
[{"id", "error"}]}: the ids this call stored and the publications the inbox
did not take, each tried whatever the others' answers.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			var publications []messaging.ThreadPublication
			b, err := io.ReadAll(a.env.Stdin)
			if err != nil {
				return err
			}
			if err = json.Unmarshal(b, &publications); err != nil {
				return err
			}
			created, refused := messaging.CaptureThreads(a.env, publications)
			return json.NewEncoder(a.env.Stdout).Encode(map[string]any{"created": created, "refused": refused})
		},
	}
	routes := &cobra.Command{
		Use:   "routes",
		Short: "List the routing inbox's pending thread publications",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			publications, err := messaging.ThreadRoutes(a.env)
			if err != nil {
				return err
			}
			return json.NewEncoder(a.env.Stdout).Encode(publications)
		},
	}
	var facts messaging.RouteFacts
	var record string
	route := &cobra.Command{
		Use:   "route <id>",
		Short: "Advance one routing inbox entry from the daemon's fresh facts",
		Long: `Decide one routing inbox entry from its lifecycle currency and, once its
recipient resolves, the recipient's routing record, host and local inbox key.
Prints {"action": ...}: wait; forward or session with the entry's record, for
the daemon to hand off and settle; or placed, superseded or expired, which this
call recorded. A placed result is enqueued in the recipient fiber's inbox.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			host, err := a.resolveOwnHost("")
			if err != nil {
				return err
			}
			facts.ID = args[0]
			if record != "" {
				if err := json.Unmarshal([]byte(record), &facts.Record); err != nil {
					return err
				}
			}
			decision, err := messaging.RouteThread(a.env, host, facts)
			if err != nil {
				return err
			}
			return json.NewEncoder(a.env.Stdout).Encode(decision)
		},
	}
	route.Flags().StringVar(&facts.Current, "current", "unknown", "Fresh lifecycle currency: true, false or unknown")
	route.Flags().StringVar(&record, "record", "", "The resolved recipient's routing fields as JSON")
	route.Flags().StringVar(&facts.Owner, "owner", "", "The resolved recipient's host")
	route.Flags().StringVar(&facts.Key, "key", "", "The resolved recipient's local inbox key")
	settle := &cobra.Command{
		Use:   "settle <id> forwarded|delivered|undeliverable",
		Short: "Record a routing inbox entry's confirmed handoff",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return messaging.SettleThread(a.env, args[0], args[1])
		},
	}
	return []*cobra.Command{state, capture, routes, route, settle}
}
