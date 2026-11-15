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
		Long: `Read a JSON array of {"id", "record", "board"} thread publications on
stdin, possibly empty, and enqueue each into the routing inbox. A
publication's optional board record is stored in its entry, which owes the
line until it is appended. Every call then appends each line the routing
inbox's entries owe, pending or offered, from the record the first capture
stored and under the identity brd-<id>, so a repeat after a lost record of
the append replaces the line rather than adding one. Prints {"created":
[ids], "refused": [{"id", "error"}], "board_errors": [{"id", "error"}]}: the
ids this call stored, the publications the inbox did not take, each tried
whatever the others' answers, and the owed lines that could not be appended,
which the next call tries again.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			var input []struct {
				messaging.ThreadPublication
				Board *boardRecord `json:"board"`
			}
			b, err := io.ReadAll(a.env.Stdin)
			if err != nil {
				return err
			}
			if err = json.Unmarshal(b, &input); err != nil {
				return err
			}
			publications := make([]messaging.ThreadPublication, len(input))
			for i, p := range input {
				if p.Board != nil {
					p.Record["board"] = p.Board
				}
				publications[i] = p.ThreadPublication
			}
			c := messaging.CaptureThreads(a.env, publications)
			owed, err := messaging.OwedBoardLines(a.env)
			if err != nil {
				return err
			}
			boardErrors := []messaging.ThreadRefusal{}
			for _, line := range owed {
				err := a.appendOwedBoardLine(line)
				if err == nil {
					err = messaging.BoardLineAppended(a.env, line.ID)
				}
				if err != nil {
					boardErrors = append(boardErrors, messaging.ThreadRefusal{ID: line.ID, Error: err.Error()})
				}
			}
			return json.NewEncoder(a.env.Stdout).Encode(map[string]any{"created": c.Created, "refused": c.Refused, "board_errors": boardErrors})
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
recipient resolves, the recipient's routing record and, when this host owns
the recipient, its inbox key; a record without a key is forwarded.
Prints {"action": ...}: wait; forward or session with the entry's record, for
the daemon to hand off and settle; or placed, superseded or expired, which this
call recorded. A placed result is enqueued in the recipient fiber's inbox.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			facts.ID = args[0]
			if record != "" {
				if err := json.Unmarshal([]byte(record), &facts.Record); err != nil {
					return err
				}
			}
			decision, err := messaging.RouteThread(a.env, facts)
			if err != nil {
				return err
			}
			return json.NewEncoder(a.env.Stdout).Encode(decision)
		},
	}
	route.Flags().StringVar(&facts.Current, "current", "unknown", "Fresh lifecycle currency: true, false or unknown")
	route.Flags().StringVar(&record, "record", "", "The resolved recipient's routing fields as JSON")
	route.Flags().StringVar(&facts.Key, "key", "", "The resolved recipient's inbox key, when this host owns it")
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

// appendOwedBoardLine appends an owed line from the board record its entry
// stored, under the publication's identity.
func (a *app) appendOwedBoardLine(line messaging.OwedBoardLine) error {
	b, err := json.Marshal(line.Board)
	if err != nil {
		return err
	}
	var board boardRecord
	if err = json.Unmarshal(b, &board); err != nil {
		return err
	}
	board.ID = "brd-" + line.ID
	return a.appendBoard(board)
}
