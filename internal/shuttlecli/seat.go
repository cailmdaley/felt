package shuttlecli

import (
	"fmt"

	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

func (a *app) seatCmd() *cobra.Command {
	var clear bool
	cmd := &cobra.Command{
		Use:   "seat <fiber>",
		Short: "Mark a constitution as a seat of its role, or clear the seat",
		Long: `Sets shuttle.seat to true, placing the resting constitution in the board's
Roles band. The constitution must have shuttle.role. --clear removes the seat
without changing its role, lifecycle or runtime state.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			f, st, block, ref, unlock, err := a.resolveOwnedShuttleFiber(args[0], "use 'shuttle install' first")
			if err != nil {
				return err
			}
			defer unlock()
			owner, err := a.routeOwnerForCommand(cmd, args, block.Host)
			if err != nil {
				return err
			}
			fields := map[string]any{}
			if clear {
				fields["clear"] = true
			}
			if routed, err := a.forwardLifecycleAction(cmd, args, owner, "seat", f, fields); routed || err != nil {
				return err
			}
			if !clear && !shuttle.ValidRole(block.Role) {
				return fmt.Errorf("seat requires shuttle.role; use 'shuttle role %s <role>' first", args[0])
			}
			var value any
			if !clear {
				value = true
			}
			if err := shuttle.SetNodeField(f, "seat", value); err != nil {
				return err
			}
			if err := st.Write(f); err != nil {
				return fmt.Errorf("writing fiber: %w", err)
			}
			if clear {
				fmt.Fprintf(a.env.Stdout, "cleared the seat of %s%s\n", args[0], ref.Location())
			} else {
				fmt.Fprintf(a.env.Stdout, "%s%s is a seat of roles/%s\n", args[0], ref.Location(), block.Role)
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&clear, "clear", false, "Remove the seat")
	cmd.Flags().Bool("local", false, localFlagUsage)
	return cmd
}
