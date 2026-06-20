package cmd

import (
	"fmt"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var initCmd = &cobra.Command{
	Use:   "init",
	Short: "Initialize a new felt repository",
	Long:  `Creates or repairs the local .felt/ directory and felt support files.`,
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		storage := felt.NewStorage(".")
		if err := storage.Init(); err != nil {
			return err
		}
		// Init() does os.MkdirAll first, so a nil return means the dir exists.
		fmt.Println("Ensured .felt/ support files")
		return nil
	},
}

func init() {
	rootCmd.AddCommand(initCmd)
}
