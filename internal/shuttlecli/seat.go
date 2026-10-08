package shuttlecli

import (
	"fmt"
	"path"

	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

// seatCmd sets or clears shuttle.seat: the role a constitution is a seat of.
func (a *app) seatCmd() *cobra.Command {
	var clear bool
	seatCmd := &cobra.Command{
		Use:   "seat <fiber> [role]",
		Short: "Make a constitution a seat of a role, or clear it",
		Long: `Sets shuttle.seat to a role's slug: the constitution becomes a seat of that
office. A worker there sits in the role, and the board draws the constitution at
rest among the Roles rather than in Resting. The role resolves like 'shuttle
assign --role' (a slug, roles/<slug>, a name or a UID) and must have a charter
under roles/. --clear removes the seat. Lifecycle, roster and runtime keys are
untouched; a role can have any number of seats.`,
		Args: cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if clear == (len(args) == 2) {
				return fmt.Errorf("name a role, or pass --clear")
			}
			f, st, block, ref, unlock, err := a.resolveOwnedShuttleFiber(args[0], "use 'shuttle install' first")
			if err != nil {
				return err
			}
			defer unlock()
			owner, err := a.routeOwnerForCommand(cmd, args, block.Host)
			if err != nil {
				return err
			}
			fields := map[string]any{"clear": clear}
			if !clear {
				fields["role"] = args[1]
			}
			if routed, err := a.forwardLifecycleAction(cmd, args, owner, "seat", f, fields); routed || err != nil {
				return err
			}

			slug := ""
			if clear {
				if err := shuttle.SetNodeField(f, "seat", nil); err != nil {
					return err
				}
			} else {
				profiles, err := listRoleProfiles(st)
				if err != nil {
					return err
				}
				role, err := resolveRoleProfile(profiles, args[1])
				if err != nil {
					return err
				}
				slug = path.Base(role.ID)
				if !isRoleRoot(role.ID) || !shuttle.ValidSeat(slug) {
					return fmt.Errorf("%s is not a role charter a seat can name", role.ID)
				}
				if err := shuttle.SetField(f, "seat", slug); err != nil {
					return err
				}
			}
			if err := st.Write(f); err != nil {
				return fmt.Errorf("writing fiber: %w", err)
			}
			if clear {
				fmt.Fprintf(a.env.Stdout, "cleared the seat of %s%s\n", args[0], ref.Location())
			} else {
				fmt.Fprintf(a.env.Stdout, "%s%s is a seat of roles/%s\n", args[0], ref.Location(), slug)
			}
			return nil
		},
	}
	seatCmd.Flags().BoolVar(&clear, "clear", false, "remove the seat")
	seatCmd.Flags().Bool("local", false, localFlagUsage)
	return seatCmd
}
