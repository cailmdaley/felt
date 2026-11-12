package shuttlecli

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
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
		Long: `Sets shuttle.role to a single role slug whose charter is roles/<slug> at the
top of the shared store, or <mount>/roles/<slug> in a repository linked in at
its top level (see the roles concept page).
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
				charters, _, err := roleCharters(st)
				if err != nil {
					return err
				}
				if charters[args[1]] == nil {
					if !cmd.Flags().Changed("new") {
						return noCharterError(args[1])
					}
					charter := &felt.Felt{
						ID: "roles/" + args[1], Name: newName, Tags: []string{"role"},
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
			if err := a.writeFiber(st, f); err != nil {
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

// roleCharters finds every role's charter in the shared store (the enclosing
// store when st is a view): the fiber at roles/<slug> at its top, or at
// <mount>/roles/<slug> where <mount> is a top-level entry of its .felt/ that
// links to a directory. The store's own charter wins a slug collision, then
// mounts in name order; the charters a winner hides are returned as shadowed.
// It reads those roles/ directories and their charters, never the rest of the
// store.
func roleCharters(st *felt.Storage) (charters map[string]*felt.Felt, shadowed []*felt.Felt, err error) {
	st = roleStorage(st)
	root := st.Root()
	ids, err := charterIDs(root, "")
	if err != nil {
		return nil, nil, err
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, nil, err
	}
	for _, entry := range entries {
		if entry.Type()&fs.ModeSymlink == 0 {
			continue
		}
		if info, err := os.Stat(filepath.Join(root, entry.Name())); err != nil || !info.IsDir() {
			continue
		}
		mounted, err := charterIDs(root, entry.Name()+"/")
		if err != nil {
			return nil, nil, err
		}
		ids = append(ids, mounted...)
	}
	found, err := st.ListMetadataByIDs(ids, nil, false)
	if err != nil {
		return nil, nil, err
	}
	charters = map[string]*felt.Felt{}
	for _, f := range found {
		slug := path.Base(f.ID)
		if charters[slug] != nil {
			shadowed = append(shadowed, f)
			continue
		}
		charters[slug] = f
	}
	return charters, shadowed, nil
}

// charterIDs lists the candidate charter ids <prefix>roles/<slug> under root.
func charterIDs(root, prefix string) ([]string, error) {
	entries, err := os.ReadDir(filepath.Join(root, filepath.FromSlash(prefix), felt.RolesNamespace))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(entries))
	for _, entry := range entries {
		if (entry.IsDir() || entry.Type()&fs.ModeSymlink != 0) && shuttle.ValidRole(entry.Name()) {
			ids = append(ids, prefix+felt.RolesNamespace+"/"+entry.Name())
		}
	}
	return ids, nil
}

// noCharterError names where a role's charter may live.
func noCharterError(role string) error {
	return fmt.Errorf("role %q has no charter at roles/%s or <mount>/roles/%s", role, role, role)
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
		Use: "roles", Short: "List role charters in the shared store and its mounts", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			st, _, err := felt.RequireStore(a.env, a.dir)
			if err != nil {
				return err
			}
			charters, _, err := roleCharters(st)
			if err != nil {
				return err
			}
			type profile struct {
				Slug    string `json:"slug"`
				ID      string `json:"id"`
				Name    string `json:"name"`
				Outcome string `json:"outcome"`
			}
			roles := make([]profile, 0, len(charters))
			for slug, f := range charters {
				roles = append(roles, profile{slug, f.ID, f.Name, f.Outcome})
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
