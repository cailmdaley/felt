package shuttlecli

import (
	"fmt"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

var shuttleCheckCmd = &cobra.Command{
	Use:   "check",
	Short: "Validate Shuttle blocks and host identity in this store",
	Long:  "Checks every mapping-valued shuttle: block against Shuttle's schema and reports local host-name drift.",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		storage, _, err := felt.RequireStore(changeDir)
		if err != nil {
			return err
		}
		fibers, err := storage.ListMetadata()
		if err != nil {
			return err
		}
		issues := make([]felt.CheckIssue, 0)
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
		}
		issues = append(issues, checkHostDrift(fibers)...)
		errors := 0
		for _, issue := range issues {
			if issue.Level == felt.CheckLevelError {
				errors++
			}
		}
		if jsonOutput {
			if err := outputJSON(issues); err != nil {
				return err
			}
		} else if len(issues) == 0 {
			fmt.Println("Check OK")
		} else {
			for _, issue := range issues {
				fmt.Println(issue.String())
			}
		}
		if errors > 0 {
			return fmt.Errorf("shuttle check failed: %d error(s)", errors)
		}
		return nil
	},
}

func init() { addShuttleCommand(shuttleCheckCmd) }
