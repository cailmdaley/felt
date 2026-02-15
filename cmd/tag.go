package cmd

import (
	"fmt"
	"strings"

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

		// Split comma-separated tags: "claim, tapestry:foo" → ["claim", "tapestry:foo"]
		tags := splitTags(args[1])
		for _, tag := range tags {
			if f.HasTag(tag) {
				continue
			}
			f.AddTag(tag)
			fmt.Printf("%s +[%s]\n", f.ID, tag)
		}

		if err := storage.Write(f); err != nil {
			return err
		}
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

		tags := splitTags(args[1])
		for _, tag := range tags {
			if !f.HasTag(tag) {
				continue
			}
			f.RemoveTag(tag)
			fmt.Printf("%s -[%s]\n", f.ID, tag)
		}

		if err := storage.Write(f); err != nil {
			return err
		}
		return nil
	},
}

// splitTags splits comma-separated tag input into individual tags.
// "claim, tapestry:foo" → ["claim", "tapestry:foo"]
func splitTags(input string) []string {
	parts := strings.Split(input, ",")
	var tags []string
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			tags = append(tags, p)
		}
	}
	return tags
}

func init() {
	rootCmd.AddCommand(tagCmd)
	rootCmd.AddCommand(untagCmd)
}
