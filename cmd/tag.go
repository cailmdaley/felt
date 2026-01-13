package cmd

import (
	"fmt"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var tagCmd = &cobra.Command{
	Use:   "tag <id> <tag>",
	Short: "Add a tag to a felt",
	Long:  `Adds a tag to an existing felt.`,
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := felt.FindProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}

		storage := felt.NewStorage(root)
		f, err := storage.Find(args[0])
		if err != nil {
			return err
		}

		tag := args[1]
		if f.HasTag(tag) {
			return fmt.Errorf("felt %s already has tag %q", f.ID, tag)
		}

		f.AddTag(tag)
		if err := storage.Write(f); err != nil {
			return err
		}

		fmt.Printf("%s +[%s]\n", f.ID, tag)
		return nil
	},
}

var untagCmd = &cobra.Command{
	Use:   "untag <id> <tag>",
	Short: "Remove a tag from a felt",
	Long:  `Removes a tag from an existing felt.`,
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := felt.FindProjectRoot()
		if err != nil {
			return fmt.Errorf("not in a felt repository")
		}

		storage := felt.NewStorage(root)
		f, err := storage.Find(args[0])
		if err != nil {
			return err
		}

		tag := args[1]
		if !f.HasTag(tag) {
			return fmt.Errorf("felt %s does not have tag %q", f.ID, tag)
		}

		f.RemoveTag(tag)
		if err := storage.Write(f); err != nil {
			return err
		}

		fmt.Printf("%s -[%s]\n", f.ID, tag)
		return nil
	},
}

func init() {
	rootCmd.AddCommand(tagCmd)
	rootCmd.AddCommand(untagCmd)
}
