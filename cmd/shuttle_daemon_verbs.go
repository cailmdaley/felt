package cmd

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/spf13/cobra"
)

// The daemon-coupled passthrough verbs: snapshot (raw GET /api/v1/state) and
// dispatch (POST /api/v1/dispatch). Unlike the local-read verbs (status/ps), which
// felt now answers from its own data model, these query the running OTP daemon's
// live runtime state, which has no felt-internal analogue — so they stay thin
// passthroughs over the shared daemon transport in shuttle_daemon.go, printing
// whatever the daemon said.

var shuttleSnapshotCmd = &cobra.Command{
	Use:   "snapshot",
	Short: "Print the local daemon's state snapshot",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		body, err := getDaemon(daemonURL()+"/api/v1/state", daemonReadTimeout)
		if err != nil {
			return err
		}
		printDaemonBody(body)
		return nil
	},
}

var shuttleDispatchCmd = &cobra.Command{
	Use:   "dispatch <fiber>",
	Short: "Ask the local daemon to dispatch a fiber now",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		adHoc, _ := cmd.Flags().GetBool("ad-hoc")
		payload, _ := json.Marshal(map[string]any{
			"fiber_id": args[0],
			"ad_hoc":   adHoc,
		})
		body, err := postDaemon(daemonURL()+"/api/v1/dispatch", payload, daemonPostTimeout)
		if err != nil {
			return err
		}
		printDaemonBody(body)
		return nil
	},
}

// printDaemonBody echoes a daemon response verbatim, adding the newline the
// daemon may not have sent so the shell prompt does not land mid-line.
func printDaemonBody(body []byte) {
	fmt.Print(string(body))
	if !bytes.HasSuffix(body, []byte("\n")) {
		fmt.Println()
	}
}

func init() {
	shuttleDispatchCmd.Flags().Bool("ad-hoc", false, "For standing roles, dispatch an ad-hoc run without consuming the scheduled occurrence")
	shuttleCmd.AddCommand(shuttleSnapshotCmd)
	shuttleCmd.AddCommand(shuttleDispatchCmd)
}
