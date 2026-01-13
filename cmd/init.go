package cmd

import (
	"fmt"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var initCmd = &cobra.Command{
	Use:   "init",
	Short: "Initialize a new felt repository",
	Long:  `Creates a .felt/ directory in the current directory.`,
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		storage := felt.NewStorage(".")
		if storage.Exists() {
			return fmt.Errorf(".felt directory already exists")
		}
		if err := storage.Init(); err != nil {
			return err
		}
		fmt.Println("Initialized .felt/")
		return nil
	},
}

func init() {
	rootCmd.AddCommand(initCmd)
}
