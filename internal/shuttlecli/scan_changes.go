package shuttlecli

import (
	"encoding/json"
	"path/filepath"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

func (a *app) scanChangesCmd() *cobra.Command {
	return &cobra.Command{
		Use: "scan-changes", Short: "Check a store's incremental metadata index (daemon-facing)", Hidden: true, Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			var previous felt.ChangeIndex
			if err := json.NewDecoder(a.env.Stdin).Decode(&previous); err != nil {
				return err
			}
			result, err := felt.ScanChanges(filepath.Join(a.dir, ".felt"), previous)
			if err != nil {
				return err
			}
			return json.NewEncoder(a.env.Stdout).Encode(result)
		},
	}
}
