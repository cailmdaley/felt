package shuttlecli

import "github.com/spf13/cobra"

// channelsCmd writes the board records behind the human's Channels view:
// `dismissed` sets a channel aside (or unpins it), `pinned` keeps it listed.
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
		record("dismissed", "dismiss <key>", "Set a channel aside, or unpin it, across the fleet"),
		record("pinned", "pin <key>", "Pin a channel across the fleet; it lapses with the board's reach unless pinned again"),
	)
	return cmd
}
