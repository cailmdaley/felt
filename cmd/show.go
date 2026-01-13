package cmd

import (
	"fmt"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var showCmd = &cobra.Command{
	Use:   "show <id>",
	Short: "Show details of a felt",
	Long:  `Displays the full details of a felt including its body.`,
	Args:  cobra.ExactArgs(1),
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

		if jsonOutput {
			return outputJSON(f)
		}

		// Header
		fmt.Printf("ID:       %s\n", f.ID)
		fmt.Printf("Repo:     %s\n", root)
		fmt.Printf("Title:    %s\n", f.Title)
		fmt.Printf("Status:   %s\n", f.Status)
		if f.Kind != felt.DefaultKind {
			fmt.Printf("Kind:     %s\n", f.Kind)
		}
		if len(f.Tags) > 0 {
			fmt.Printf("Tags:     %s\n", strings.Join(f.Tags, ", "))
		}
		fmt.Printf("Priority: %d\n", f.Priority)
		if len(f.DependsOn) > 0 {
			fmt.Printf("Depends:  %s\n", strings.Join(f.DependsOn, ", "))
		}
		if f.Due != nil {
			fmt.Printf("Due:      %s\n", f.Due.Format("2006-01-02"))
		}
		fmt.Printf("Created:  %s\n", f.CreatedAt.Format("2006-01-02T15:04:05-07:00"))
		if f.ClosedAt != nil {
			fmt.Printf("Closed:   %s\n", f.ClosedAt.Format("2006-01-02T15:04:05-07:00"))
		}
		if f.CloseReason != "" {
			fmt.Printf("Reason:   %s\n", f.CloseReason)
		}

		// Body
		if f.Body != "" {
			fmt.Printf("\n%s\n", f.Body)
		}

		return nil
	},
}

func init() {
	rootCmd.AddCommand(showCmd)
}
