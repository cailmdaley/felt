package shuttlecli

import (
	"fmt"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

func (a *app) roleCmd() *cobra.Command {
	var clear bool
	cmd := &cobra.Command{
		Use:   "role <fiber> [role]",
		Short: "Set a constitution's office, or clear its role and seat",
		Long: `Sets shuttle.role to a single role slug with a charter at roles/<slug>.
--clear removes both shuttle.role and shuttle.seat. Lifecycle and runtime state
are untouched.`,
		Args: cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if clear == (len(args) == 2) {
				return fmt.Errorf("name a role slug, or pass --clear")
			}
			if !clear && !shuttle.ValidRole(args[1]) {
				return fmt.Errorf("role must be a role slug, got %q", args[1])
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
			fields := map[string]any{}
			if clear {
				fields["clear"] = true
			} else {
				fields["role"] = args[1]
			}
			if routed, err := a.forwardLifecycleAction(cmd, args, owner, "role", f, fields); routed || err != nil {
				return err
			}
			if clear {
				if err := shuttle.SetNodeField(f, "role", nil); err != nil {
					return err
				}
				if err := shuttle.SetNodeField(f, "seat", nil); err != nil {
					return err
				}
			} else {
				if !roleRoots(st)[args[1]] {
					return fmt.Errorf("role %q has no charter at roles/%s", args[1], args[1])
				}
				if err := shuttle.SetField(f, "role", args[1]); err != nil {
					return err
				}
			}
			if err := st.Write(f); err != nil {
				return fmt.Errorf("writing fiber: %w", err)
			}
			if clear {
				fmt.Fprintf(a.env.Stdout, "cleared role and seat of %s%s\n", args[0], ref.Location())
			} else {
				fmt.Fprintf(a.env.Stdout, "%s%s has role %s\n", args[0], ref.Location(), args[1])
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&clear, "clear", false, "Remove the role and seat")
	cmd.Flags().Bool("local", false, localFlagUsage)
	return cmd
}

// listRoleProfiles reads metadata from the store that owns the roles namespace.
func listRoleProfiles(st *felt.Storage) ([]*felt.Felt, error) {
	if external := st.ExternalRefs(); external != nil {
		st = felt.NewStorage(external.ProjectDir())
	}
	return st.ListMetadata()
}
