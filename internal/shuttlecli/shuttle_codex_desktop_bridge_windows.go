//go:build windows

package shuttlecli

import (
	"errors"

	"github.com/spf13/cobra"
)

var codexDesktopBridgeCmd = &cobra.Command{
	Use:   "codex-desktop-bridge",
	Short: "Bridge Codex desktop JSONL to a native app-server websocket",
	RunE: func(*cobra.Command, []string) error {
		return errors.New("codex-desktop-bridge requires Unix domain sockets")
	},
}

func init() { addShuttleCommand(codexDesktopBridgeCmd) }
