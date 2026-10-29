package shuttlecli

import (
	"fmt"
	"time"

	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

func (a *app) askCmd() *cobra.Command {
	var askClear bool
	var answeredBy string
	askCmd := &cobra.Command{
		Use:   "ask <fiber> [question]",
		Short: "Set or clear a worker's outstanding one-line question",
		Long: `Writes shuttle.ask {text, at} locally without contacting the daemon.
The fiber must carry a shuttle: block owned by this host. --clear removes the
question. Status, outcome and configuration remain unchanged. A question
asked by the thread's own orchestrator is marked so that it is not delivered
back to that orchestrator (shuttle.runtime.orchestrator_acted_at).`,
		Args: func(cmd *cobra.Command, args []string) error {
			if answeredBy != "" && !askClear {
				return fmt.Errorf("--answered-by requires --clear")
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
			if err := st.Write(f); err != nil {
				return fmt.Errorf("writing fiber: %w", err)
			}
			// Clearing a fiber with no question is a no-op on the board: the daemon
			// clears after every delivered message and every forced start.
			if !askClear {
				a.recordBoard(boardRecord{Kind: "asked", Fiber: f.UID, By: a.boardWorkerParty(), Text: args[1]})
			} else if oldAsk != nil {
				kind, by := "cleared", a.boardWorkerParty()
				if answeredBy != "" {
					kind, by = "answered", a.boardMessageActor(answeredBy)
				}
				a.recordBoard(boardRecord{Kind: kind, Fiber: f.UID, By: by, Text: oldAsk.Text})
			}
			fmt.Fprintf(a.env.Stdout, "updated question for %s%s\n", args[0], ref.Location())
			return nil
		},
	}
	askCmd.Flags().BoolVar(&askClear, "clear", false, "Remove the outstanding question")
	askCmd.Flags().StringVar(&answeredBy, "answered-by", "", "Record the label of the person who answered")
	_ = askCmd.Flags().MarkHidden("answered-by")
	return askCmd
}

// clearMessagedFiberAsk clears local fiber-addressed questions once a message
// is accepted, delivered or queued for the fiber's next worker. Remote and session-addressed delivery is handled by the owner daemon.
func (a *app) clearMessagedFiberAsk(target string, sender ...string) error {
	lookup, err := a.lookupShuttleAddressFibers(target)
	if err != nil || len(lookup.Fibers) != 1 || lookup.refused() {
		return nil
	}
	// Fiber-addressed messages can target work owned by another host. Its
	// question is cleared by the owner daemon after delivery; trying to resolve
	// that fiber in this checkout can fail even though the message succeeded.
	if a.ensureOwnedHere(lookup.Fibers[0], target) != nil {
		return nil
	}
	f, st, _, err := a.shuttleResolveFiberRef(lookup.Fibers[0].ID, true)
	if err != nil {
		return err
	}
	f, unlock, err := lockAndReloadFiber(st, f)
	if err != nil {
		return err
	}
	defer unlock()
	if a.ensureOwnedHere(f, target) != nil {
		return nil
	}
	block, ok, err := shuttle.BlockOf(f)
	if err != nil {
		return err
	}
	if !ok || block.Ask == nil {
		return nil
	}
	if err := shuttle.SetNodeField(f, "ask", nil); err != nil {
		return err
	}
	if err := st.Write(f); err != nil {
		return err
	}
	var by *boardParty
	if len(sender) > 0 {
		by = a.boardMessageActor(sender[0])
	}
	a.recordBoard(boardRecord{Kind: "answered", Fiber: f.UID, By: by, Text: block.Ask.Text})
	return nil
}
