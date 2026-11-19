package shuttlecli

import (
	"fmt"
	"strings"

	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

func (a *app) channelCmd() *cobra.Command {
	var clear bool
	cmd := &cobra.Command{
		Use:   "channel <fiber> [name]",
		Short: "Set or clear the board channel a constitution declares",
		Long: `Sets shuttle.channel to <name>, trimmed and otherwise as given: the
constitutions declaring one name speak in one board channel, and a thread
inherits its ancestor's. --clear removes the key. Any status is accepted,
closed included; status, outcome, configuration and runtime are untouched.`,
		Args: cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if clear == (len(args) == 2) {
				return fmt.Errorf("name a channel, or pass --clear")
			}
			var name string
			if !clear {
				name = strings.TrimSpace(args[1])
				if name == "" {
					return fmt.Errorf("channel name is empty")
				}
				if strings.ContainsAny(name, "\r\n") {
					return fmt.Errorf("channel name must be one line")
				}
			}
			f, st, block, ref, unlock, err := a.resolveOwnedShuttleFiber(args[0], "use 'shuttle install' first")
			if err != nil {
				return err
			}
			defer unlock()
			owner, err := a.routeOwnerForCommand(cmd, args, block.Host)
			if err != nil {
				return err
			}
			fields := map[string]any{}
			if !clear {
				fields["channel"] = name
			}
			if routed, err := a.forwardLifecycleAction(cmd, args, owner, "channel", f, fields); routed || err != nil {
				return err
			}
			var value any
			if !clear {
				value = name
			}
			if err := shuttle.SetNodeField(f, "channel", value); err != nil {
				return err
			}
			if err := a.writeFiber(st, f); err != nil {
				return fmt.Errorf("writing fiber: %w", err)
			}
			if clear {
				fmt.Fprintf(a.env.Stdout, "cleared the channel of %s%s\n", args[0], ref.Location())
			} else {
				fmt.Fprintf(a.env.Stdout, "%s%s speaks in channel %q\n", args[0], ref.Location(), name)
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&clear, "clear", false, "Remove the channel")
	cmd.Flags().Bool("local", false, localFlagUsage)
	return cmd
}
