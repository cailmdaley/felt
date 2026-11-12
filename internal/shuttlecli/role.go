package shuttlecli

import (
	"fmt"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

func (a *app) roleCmd() *cobra.Command {
	var clear bool
	var newName string
	cmd := &cobra.Command{
		Use:   "role <fiber> [role]",
		Short: "Set a constitution's role, or clear its role and seat",
		Long: `Sets the fiber's top-level role to <office> or <office>/<person> and removes
any shuttle.role from its block. A bare office is stored as <office>/<person>
when the repository holding the fiber names a person (git config felt.person).
The office's charter is roles/<office> at the top of the shared store, or
<mount>/roles/<office> in a repository linked in at its top level (see the
roles concept page); the per-person roles/<office>/<person> is optional.
--clear removes the role and shuttle.seat. Lifecycle and runtime state are
untouched. --new "Office name" creates a missing charter in the shared store's
roles/ before assigning the role; existing charters are preserved.`,
		Args: cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if clear == (len(args) == 2) {
				return fmt.Errorf("name a role slug, or pass --clear")
			}
			if cmd.Flags().Changed("new") && (clear || strings.TrimSpace(newName) == "") {
				return fmt.Errorf("--new requires a role slug and a non-empty office name")
			}
			if !clear && !shuttle.ValidRole(args[1]) {
				return fmt.Errorf("role must be <office> or <office>/<person>, each a slug, got %q", args[1])
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
				if cmd.Flags().Changed("new") {
					fields["new_name"] = newName
				}
			}
			if routed, err := a.forwardLifecycleAction(cmd, args, owner, "role", f, fields); routed || err != nil {
				return err
			}
			role := ""
			if clear {
				if err := shuttle.SetNodeField(f, "seat", nil); err != nil {
					return err
				}
			} else {
				role = felt.QualifyRole(args[1], st.Path(f.ID))
				office := shuttle.OfficeOf(role)
				charters, _, err := st.RoleCharters()
				if err != nil {
					return err
				}
				if charters[office] == nil {
					if !cmd.Flags().Changed("new") {
						return felt.NoCharterError(office)
					}
					charter := &felt.Felt{
						ID: "roles/" + office, Name: newName, Tags: []string{"role"},
						Body: fmt.Sprintf("The %s office serves the constitution %q. Its holders grow this charter with the office's remit, playbooks, and human gates.\n", newName, f.Name),
					}
					if err := createRoleCharter(st.RoleStorage(), charter); err != nil {
						return fmt.Errorf("creating role charter: %w", err)
					}
				}
			}
			if err := shuttle.SetRole(f, role); err != nil {
				return err
			}
			if err := a.writeFiber(st, f); err != nil {
				return fmt.Errorf("writing fiber: %w", err)
			}
			if clear {
				fmt.Fprintf(a.env.Stdout, "cleared role and seat of %s%s\n", args[0], ref.Location())
			} else {
				fmt.Fprintf(a.env.Stdout, "%s%s has role %s\n", args[0], ref.Location(), role)
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&clear, "clear", false, "Remove the role and seat")
	cmd.Flags().StringVar(&newName, "new", "", "Create a missing charter with this office name")
	cmd.Flags().Bool("local", false, localFlagUsage)
	return cmd
}

// createRoleCharter checks the destination independently of the metadata index,
// which omits malformed documents. The lock serializes competing role creators;
// availability is checked again under it before the write.
func createRoleCharter(st *felt.Storage, charter *felt.Felt) error {
	if err := st.CheckAvailableID(charter.ID); err != nil {
		return err
	}
	unlock, err := st.LockFiber(charter.ID)
	if err != nil {
		return err
	}
	defer unlock()
	if err := st.CheckAvailableID(charter.ID); err != nil {
		return err
	}
	return st.Write(charter)
}
