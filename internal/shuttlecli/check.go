package shuttlecli

import (
	"fmt"
	"path"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

func (a *app) shuttleCheckCmd() *cobra.Command {
	shuttleCheckCmd := &cobra.Command{
		Use:   "check",
		Short: "Validate Shuttle blocks and host identity in this store",
		Long:  "Checks shuttle: blocks against Shuttle's schema and reports local host-name drift.",
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
			// An unreadable roles namespace yields no charters, so every role
			// is reported rather than none.
			charters, shadowed, _ := roleCharters(storage)
			for _, f := range shadowed {
				slug := path.Base(f.ID)
				issues = append(issues, felt.CheckIssue{
					Level:   felt.CheckLevelWarning,
					FiberID: f.ID,
					Message: fmt.Sprintf("charter for role %q is shadowed by %s, which wins", slug, charters[slug].ID),
				})
			}
			for _, fiber := range fibers {
				if _, exists := fiber.ExtraFields["collaboration"]; exists {
					issues = append(issues, felt.CheckIssue{
						Level: felt.CheckLevelError, FiberID: fiber.ID, Path: "collaboration",
						Message: "migrate this store: replace collaboration with one shuttle.role slug and remove collaboration",
					})
				}
				if !shuttle.HasFacet(fiber) {
					if _, exists := fiber.ExtraFields[shuttle.FacetKey]; exists {
						issues = append(issues, felt.CheckIssue{
							Level: felt.CheckLevelWarning, FiberID: fiber.ID, Path: shuttle.FacetKey,
							Message: "shuttle must be a mapping; this fiber is treated as ordinary",
						})
					}
					continue
				}
				if seat := felt.MappingValueNode(fiber.ExtraFields[shuttle.FacetKey], "seat"); seat != nil && seat.Kind == yaml.ScalarNode && seat.Tag == "!!str" {
					issues = append(issues, felt.CheckIssue{
						Level: felt.CheckLevelError, FiberID: fiber.ID, Path: "shuttle.seat",
						Message: "migrate this store: set shuttle.role to the office slug and shuttle.seat: true",
					})
				}
				if err := shuttle.ValidateFacet(fiber); err != nil {
					issues = append(issues, felt.CheckIssue{
						Level:   felt.CheckLevelError,
						FiberID: fiber.ID,
						Path:    shuttle.FacetKey,
						Message: err.Error(),
					})
				}
				if readTempered(fiber) != nil && fiber.Status != felt.StatusClosed {
					issues = append(issues, felt.CheckIssue{
						Level:   felt.CheckLevelWarning,
						FiberID: fiber.ID,
						Path:    shuttleTemperedKey,
						Message: "tempered is a verdict on a closed card and is ignored here; remove it (shuttle rest, reopen and resume clear it as they move a card)",
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
				if block, ok, err := shuttle.BlockOf(fiber); err == nil && ok && block.Role != "" && shuttle.ValidRole(block.Role) {
					if charters[block.Role] == nil {
						issues = append(issues, felt.CheckIssue{
							Level:   felt.CheckLevelWarning,
							FiberID: fiber.ID,
							Path:    shuttle.FacetKey + ".role",
							Message: noCharterError(block.Role).Error(),
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
