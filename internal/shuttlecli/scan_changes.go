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
			// The daemon retains the metadata index as opaque JSON bytes. Keep
			// only the small changed-address header in the BEAM JSON parser.
			header, err := json.Marshal(struct {
				IDs          []string `json:"ids"`
				IndexedPaths int      `json:"indexed_paths"`
			}{IDs: result.IDs, IndexedPaths: len(result.Index)})
			if err != nil {
				return err
			}
			index, err := json.Marshal(result.Index)
			if err != nil {
				return err
			}
			if _, err := a.env.Stdout.Write(header); err != nil {
				return err
			}
			if _, err := a.env.Stdout.Write([]byte{'\n'}); err != nil {
				return err
			}
			_, err = a.env.Stdout.Write(index)
			return err
		},
	}
}
