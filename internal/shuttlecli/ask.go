package shuttlecli

import (
	"fmt"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

func (a *app) askCmd() *cobra.Command {
	var askClear, noBoard bool
	var answeredBy, replyTo string
	askCmd := &cobra.Command{
		Use:   "ask <fiber> [question]",
		Short: "Set or clear a worker's outstanding one-line question",
		Long: `Writes shuttle.ask {text, at} locally without contacting the daemon.
The fiber must carry a shuttle: block owned by this host. --clear removes the
question. Status, outcome and configuration remain unchanged. A question
asked by the thread's own orchestrator is marked so that it is not delivered
back to that orchestrator (shuttle.runtime.orchestrator_acted_at). A worker
asking on its own top-level oneshot must have written the fiber's tapestry.html
since it was dispatched.`,
		Args: func(cmd *cobra.Command, args []string) error {
			if answeredBy != "" && !askClear {
				return fmt.Errorf("--answered-by requires --clear")
			}
			if replyTo != "" && !askClear {
				return fmt.Errorf("--reply-to requires --clear")
			}
			if askClear {
				return cobra.ExactArgs(1)(cmd, args)
			}
			return cobra.ExactArgs(2)(cmd, args)
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			f, st, block, ref, unlock, err := a.resolveOwnedShuttleFiber(args[0], "")
			if err != nil {
				return err
			}
			defer unlock()
			if err := a.ensureOwnedHere(f, args[0]); err != nil {
				return err
			}
			if askClear && answeredBy != "" && block.Ask != nil && !a.answersAsk(st, f, answeredBy, replyTo) {
				fmt.Fprintf(a.env.Stdout, "question for %s stands: %s is not who it asks\n", args[0], answeredBy)
				return nil
			}
			if !askClear {
				if err := a.requireReviewReport(f); err != nil {
					return err
				}
			}
			var value any
			oldAsk := block.Ask
			block.Ask = nil
			if !askClear {
				block.Ask = &shuttle.Ask{Text: args[1], At: time.Now().UTC().Format(time.RFC3339Nano)}
				value = block.Ask
			}
			if errs := shuttle.Validate(block, nil); len(errs) > 0 {
				return a.printShuttleValidationErrors(errs)
			}
			if err := shuttle.SetNodeField(f, "ask", value); err != nil {
				return err
			}
			if block.Ask != nil {
				if err := markOrchestratorAct(st, f, block.Ask.At, a.actorSession("")); err != nil {
					return err
				}
			}
			if err := a.writeFiber(st, f); err != nil {
				return fmt.Errorf("writing fiber: %w", err)
			}
			// Clearing a fiber with no question is a no-op on the board: the daemon
			// clears after every delivered message and every forced start.
			if !askClear {
				a.recordBoard(boardRecord{Kind: "asked", Fiber: f.UID, By: a.boardWorkerParty(), To: a.upOrHuman(st, f), Text: args[1]})
			} else if oldAsk != nil && !noBoard {
				kind, by := "cleared", a.boardWorkerParty()
				if answeredBy != "" {
					kind, by = "answered", a.resolveBoardActor(answeredBy, replyTo)
				}
				a.recordBoard(boardRecord{Kind: kind, Fiber: f.UID, By: by, Text: oldAsk.Text})
			}
			fmt.Fprintf(a.env.Stdout, "updated question for %s%s\n", args[0], ref.Location())
			return nil
		},
	}
	askCmd.Flags().BoolVar(&askClear, "clear", false, "Remove the outstanding question")
	askCmd.Flags().StringVar(&answeredBy, "answered-by", "", "Record who answered and clear only if they are who the question asks")
	_ = askCmd.Flags().MarkHidden("answered-by")
	askCmd.Flags().StringVar(&replyTo, "reply-to", "", "Fiber id or UID of a remote agent answering the question")
	_ = askCmd.Flags().MarkHidden("reply-to")
	// A human line that answers the question has already written its row.
	askCmd.Flags().BoolVar(&noBoard, "no-board", false, "Clear without a family-board row")
	_ = askCmd.Flags().MarkHidden("no-board")
	return askCmd
}

func (a *app) resolveBoardActor(sender, replyTo string) *boardParty {
	by := a.boardMessageActor(sender)
	if by.Session != "" && by.Fiber == "" && replyTo != "" {
		if isSessionULID(replyTo) {
			by.Fiber = replyTo
		} else if lookup, err := a.lookupShuttleAddressFibers(replyTo); err == nil && !lookup.refused() && len(lookup.Fibers) == 1 {
			by.Fiber = lookup.Fibers[0].UID
		}
	}
	return by
}

// answersAsk reports whether a message from sender answers f's question. A
// person (the human, or any sender named by a label) answers it; an agent,
// named by its session address (and optional replyTo fiber for cross-host
// senders), answers only the question addressed to it, which is its own
// thread's: another worker writing to the fiber leaves the question for
// whoever it asks.
func (a *app) answersAsk(st *felt.Storage, f *felt.Felt, sender, replyTo string) bool {
	by := a.resolveBoardActor(sender, replyTo)
	if by.Session == "" {
		return true
	}
	to := a.upOrHuman(st, f)
	return by.Fiber != "" && to != nil && to.Fiber == by.Fiber
}
