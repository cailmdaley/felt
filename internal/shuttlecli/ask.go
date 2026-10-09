package shuttlecli

import (
	"fmt"
	"time"

	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

var askClear bool

var askCmd = &cobra.Command{
	Use:   "ask <fiber> [question]",
	Short: "Set or clear a worker's outstanding one-line question",
	Long: `Writes shuttle.ask {text, at} locally without contacting the daemon.
The fiber must carry a shuttle: block owned by this host. --clear removes the
question. Status, outcome, configuration, and runtime remain unchanged.`,
	Args: func(cmd *cobra.Command, args []string) error {
		if askClear {
			return cobra.ExactArgs(1)(cmd, args)
		}
		return cobra.ExactArgs(2)(cmd, args)
	},
	RunE: func(cmd *cobra.Command, args []string) error {
		f, st, block, ref, unlock, err := resolveOwnedShuttleFiber(args[0], "")
		if err != nil {
			return err
		}
		defer unlock()
		if err := ensureOwnedHere(f, args[0]); err != nil {
			return err
		}
		var value any
		block.Ask = nil
		if !askClear {
			block.Ask = &shuttle.Ask{Text: args[1], At: time.Now().UTC().Format(time.RFC3339Nano)}
			value = block.Ask
		}
		if errs := shuttle.Validate(block, nil); len(errs) > 0 {
			return printShuttleValidationErrors(errs)
		}
		if err := shuttle.SetNodeField(f, "ask", value); err != nil {
			return err
		}
		if err := st.Write(f); err != nil {
			return fmt.Errorf("writing fiber: %w", err)
		}
		fmt.Printf("updated question for %s%s\n", args[0], ref.Location())
		return nil
	},
}

// clearMessagedFiberAsk clears local fiber-addressed questions only after delivery
// succeeds. Remote and session-addressed delivery is handled by the owner daemon.
func clearMessagedFiberAsk(target string) error {
	lookup, err := lookupShuttleAddressFibers(target)
	if err != nil || len(lookup.Fibers) != 1 || lookup.refused() {
		return nil
	}
	f, st, _, err := shuttleResolveFiberRef(lookup.Fibers[0].ID, true)
	if err != nil {
		return err
	}
	f, unlock, err := lockAndReloadFiber(st, f)
	if err != nil {
		return err
	}
	defer unlock()
	if ensureOwnedHere(f, target) != nil {
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
	return st.Write(f)
}

func init() {
	askCmd.Flags().BoolVar(&askClear, "clear", false, "Remove the outstanding question")
	addShuttleCommand(askCmd)
}
