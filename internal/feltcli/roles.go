package feltcli

import (
	"fmt"
	"sort"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/sysenv"
	"github.com/spf13/cobra"
)

// RoleProfile is one office in `roles --json`: its slug, its charter's id in
// the store that holds the charters, and the charter's name and outcome.
type RoleProfile struct {
	Slug    string `json:"slug"`
	ID      string `json:"id"`
	Name    string `json:"name"`
	Outcome string `json:"outcome"`
}

// NewRolesCmd builds the office listing for a Felt-compatible view; shuttle
// roles is the same command.
func NewRolesCmd(env *sysenv.Env, view ViewOptions) *cobra.Command {
	command := &cobra.Command{
		Use:   "roles",
		Short: "List the offices and their charters",
		Long: `Lists every office with a charter: the fiber roles/<office> at the top of the
store that holds the charters (the enclosing store when this one is a view), or
<mount>/roles/<office> in a repository linked in at its top level. The store's
own charter wins a collision. Each row is the office, its name, its outcome;
--json adds the charter's id.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			storage, _, err := felt.RequireStore(env, view.directory())
			if err != nil {
				return err
			}
			charters, _, err := storage.RoleCharters()
			if err != nil {
				return err
			}
			roles := make([]RoleProfile, 0, len(charters))
			for office, f := range charters {
				roles = append(roles, RoleProfile{office, f.ID, f.Name, f.Outcome})
			}
			sort.Slice(roles, func(i, j int) bool { return roles[i].Slug < roles[j].Slug })
			if view.jsonOutput() {
				return writeJSON(env.Stdout, roles)
			}
			for _, role := range roles {
				fmt.Fprintf(env.Stdout, "%s\t%s\t%s\n", role.Slug, role.Name, role.Outcome)
			}
			return nil
		},
	}
	command.GroupID = groupSearch
	return command
}
