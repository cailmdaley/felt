package shuttlecli

import "github.com/spf13/cobra"

// channelsCmd writes the board records behind the human's Channels view:
// `dismissed` sets a channel aside, hides or shows it, unpins it, or clears a
// worker's line in it; `pinned` keeps it listed; `ordered` holds the human's
// order of the rail.
func (a *app) channelsCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "channels", Short: "Manage the human's channels"}
	record := func(kind, use, short string) *cobra.Command {
		var fiber string
		verb := &cobra.Command{
			Use: use, Short: short, Args: cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				return a.appendBoard(boardRecord{Kind: kind, Text: args[0], Fiber: fiber})
			},
		}
		verb.Flags().StringVar(&fiber, "fiber", "", "Fiber uid the record names")
		return verb
	}
	cmd.AddCommand(
		record("dismissed", "dismiss <key>", "Set a channel aside, hide or show it, unpin it, or clear a line in it, across the fleet"),
		record("pinned", "pin <key>", "Pin a channel across the fleet; it lapses with the board's reach unless pinned again"),
		&cobra.Command{
			Use: "order <key>...", Short: "Order the channels across the fleet; the newest order wins, and it lapses with the board's reach unless ordered again",
			Args: cobra.MinimumNArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				return a.appendBoard(boardRecord{Kind: "ordered", Keys: args})
			},
		},
	)
	return cmd
}
