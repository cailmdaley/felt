package shuttlecli

import (
	"fmt"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

func (a *app) shuttleCheckCmd() *cobra.Command {
	shuttleCheckCmd := &cobra.Command{
		Use:   "check",
		Short: "Validate Shuttle blocks and host identity in this store",
		Long:  "Checks every mapping-valued shuttle: block against Shuttle's schema and reports local host-name drift.",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			storage, _, err := felt.RequireStore(a.env, a.dir)
			if err != nil {
				return err
			}
			fibers, err := storage.ListMetadata()
			if err != nil {
				return err
			}
			issues := make([]felt.CheckIssue, 0)
			var roles map[string]bool
			for _, fiber := range fibers {
				if !shuttle.HasFacet(fiber) {
					continue
				}
				if err := shuttle.ValidateFacet(fiber); err != nil {
					issues = append(issues, felt.CheckIssue{
						Level:   felt.CheckLevelError,
						FiberID: fiber.ID,
						Path:    shuttle.FacetKey,
						Message: err.Error(),
					})
				}
				if stored := shuttle.StoredKind(fiber); shuttle.LegacyKinds[stored] != "" {
					issues = append(issues, felt.CheckIssue{
						Level:   felt.CheckLevelWarning,
						FiberID: fiber.ID,
						Path:    shuttle.FacetKey + ".kind",
						Message: fmt.Sprintf("kind %q is retired and read as %q; scripts/migrate-pinned.py rewrites it", stored, shuttle.LegacyKinds[stored]),
					})
				}
				if block, ok, err := shuttle.BlockOf(fiber); err == nil && ok && block.Seat != "" && shuttle.ValidSeat(block.Seat) {
					if roles == nil {
						roles = roleRoots(storage)
					}
					if !roles[block.Seat] {
						issues = append(issues, felt.CheckIssue{
							Level:   felt.CheckLevelWarning,
							FiberID: fiber.ID,
							Path:    shuttle.FacetKey + ".seat",
							Message: fmt.Sprintf("seat %q names no role: there is no roles/%s fiber", block.Seat, block.Seat),
						})
					}
				}
			}
			issues = append(issues, a.checkHostDrift(fibers)...)
			errors := 0
			for _, issue := range issues {
				if issue.Level == felt.CheckLevelError {
					errors++
				}
			}
			if a.json {
				if err := a.outputJSON(issues); err != nil {
					return err
				}
			} else if len(issues) == 0 {
				fmt.Fprintln(a.env.Stdout, "Check OK")
			} else {
				for _, issue := range issues {
					fmt.Fprintln(a.env.Stdout, issue.String())
				}
			}
			if errors > 0 {
				return fmt.Errorf("shuttle check failed: %d error(s)", errors)
			}
			return nil
		},
	}
	return shuttleCheckCmd
}

// roleRoots is the set of role slugs with a charter at roles/<slug> in the
// store that owns the roles. An unreadable store yields an empty set, so every
// seat is reported rather than none.
func roleRoots(st *felt.Storage) map[string]bool {
	out := map[string]bool{}
	profiles, err := listRoleProfiles(st)
	if err != nil {
		return out
	}
	for _, f := range profiles {
		if isRoleRoot(f.ID) {
			out[strings.TrimPrefix(f.ID, "roles/")] = true
		}
	}
	return out
}
