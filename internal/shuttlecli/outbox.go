package shuttlecli

import (
	"strings"

	"github.com/spf13/cobra"
)

func (a *app) outboxCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "outbox", Short: "Manage the human's Outbox"}
	var fiber string
	dismiss := &cobra.Command{
		Use: "dismiss <key>", Short: "Dismiss an Outbox item across the fleet", Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if fiber == "" {
				parts := strings.SplitN(args[0], ":", 3)
				if len(parts) == 3 && (parts[0] == "ask" || parts[0] == "review" || parts[0] == "spoken") {
					fiber = parts[1]
				}
			}
			return a.appendBoard(boardRecord{Kind: "dismissed", Text: args[0], Fiber: fiber})
		},
	}
	dismiss.Flags().StringVar(&fiber, "fiber", "", "Item's fiber uid")
	var pinFiber string
	pin := &cobra.Command{
		Use: "pin <key>", Short: "Pin an Outbox channel across the fleet; it lapses with the board's reach unless pinned again", Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return a.appendBoard(boardRecord{Kind: "pinned", Text: args[0], Fiber: pinFiber})
		},
	}
	pin.Flags().StringVar(&pinFiber, "fiber", "", "Channel's fiber uid")
	cmd.AddCommand(dismiss, pin)
	return cmd
}
