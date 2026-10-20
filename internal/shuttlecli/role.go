package shuttlecli

import (
	"fmt"
	"sort"
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
		Short: "Set a constitution's office, or clear its role and seat",
		Long: `Sets shuttle.role to a single role slug with a charter at roles/<slug>.
--clear removes both shuttle.role and shuttle.seat. Lifecycle and runtime state
are untouched. --new "Office name" creates a missing charter in the shared
roles namespace before assigning the role; existing charters are preserved.`,
		Args: cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if clear == (len(args) == 2) {
				return fmt.Errorf("name a role slug, or pass --clear")
			}
			if cmd.Flags().Changed("new") && (clear || strings.TrimSpace(newName) == "") {
				return fmt.Errorf("--new requires a role slug and a non-empty office name")
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
				if cmd.Flags().Changed("new") {
					fields["new_name"] = newName
				}
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
					if !cmd.Flags().Changed("new") {
						return fmt.Errorf("role %q has no charter at roles/%s", args[1], args[1])
					}
					charter := &felt.Felt{
						ID: "roles/" + args[1], Name: newName,
						Body: fmt.Sprintf("The %s office serves the constitution %q. Its holders grow this charter with the office's remit, playbooks, and human gates.\n", newName, f.Name),
					}
					if err := createRoleCharter(roleStorage(st), charter); err != nil {
						return fmt.Errorf("creating role charter: %w", err)
					}
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
	cmd.Flags().StringVar(&newName, "new", "", "Create a missing charter with this office name")
	cmd.Flags().Bool("local", false, localFlagUsage)
	return cmd
}

// listRoleProfiles reads metadata from the store that owns the roles namespace.
func listRoleProfiles(st *felt.Storage) ([]*felt.Felt, error) {
	return roleStorage(st).ListMetadata()
}

func roleStorage(st *felt.Storage) *felt.Storage {
	if external := st.ExternalRefs(); external != nil {
		return felt.NewStorage(external.ProjectDir())
	}
	return st
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

func (a *app) rolesCmd() *cobra.Command {
	return &cobra.Command{
		Use: "roles", Short: "List role charters in the shared namespace", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			st, _, err := felt.RequireStore(a.env, a.dir)
			if err != nil {
				return err
			}
			profiles, err := listRoleProfiles(st)
			if err != nil {
				return err
			}
			type profile struct {
				Slug    string `json:"slug"`
				Name    string `json:"name"`
				Outcome string `json:"outcome"`
			}
			roles := make([]profile, 0)
			for _, f := range profiles {
				if strings.HasPrefix(f.ID, "roles/") && strings.Count(f.ID, "/") == 1 {
					roles = append(roles, profile{strings.TrimPrefix(f.ID, "roles/"), f.Name, f.Outcome})
				}
			}
			sort.Slice(roles, func(i, j int) bool { return roles[i].Slug < roles[j].Slug })
			if a.json {
				return a.outputJSON(roles)
			}
			for _, role := range roles {
				fmt.Fprintf(a.env.Stdout, "%s\t%s\t%s\n", role.Slug, role.Name, role.Outcome)
			}
			return nil
		},
	}
}
