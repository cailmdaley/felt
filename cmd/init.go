package cmd

import (
	"fmt"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var initCmd = &cobra.Command{
	Use:   "init",
	Short: "Initialize a new felt repository",
	Long:  `Creates or repairs the local .felt/ directory and MyST project config.`,
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		storage := felt.NewStorage(".")
		if err := storage.Init(); err != nil {
			return err
		}
		if storage.Exists() {
			fmt.Println("Ensured .felt/ and myst.yml")
			return nil
		}
		return fmt.Errorf("failed to initialize .felt/")
	},
}

func init() {
	rootCmd.AddCommand(initCmd)
}
