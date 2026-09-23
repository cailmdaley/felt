//go:build windows

package cmd

import (
	"errors"

	"github.com/spf13/cobra"
)

var codexDesktopBridgeCmd = &cobra.Command{
	Use:          "codex-desktop-bridge",
	Short:        "Bridge Codex desktop JSONL to a native app-server websocket",
	SilenceUsage: true,
	RunE: func(*cobra.Command, []string) error {
		return errors.New("codex-desktop-bridge requires Unix domain sockets")
	},
}

func init() { shuttleCmd.AddCommand(codexDesktopBridgeCmd) }
