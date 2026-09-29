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
		endpoint, err := daemonEndpoint("/api/v1/state")
		if err != nil {
			return err
		}
		body, err := getDaemon(endpoint, daemonReadTimeout)
		if err != nil {
			return err
		}
		printDaemonBody(body)
		return nil
	},
}

var shuttleDispatchCmd = &cobra.Command{
	Use:   "dispatch <fiber>",
	Short: "Ask the owning daemon to dispatch a fiber now",
	Long: `Routes a remote-owned fiber through this host's daemon to the owner.
Use --message or --message-file to add a launch directive (the From User prompt block).`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		adHoc, _ := cmd.Flags().GetBool("ad-hoc")
		message, messageSet, err := readLaunchMessage(cmd, dispatchMessage, dispatchMessageFile)
		if err != nil {
			return err
		}
		fields := map[string]any{"ad_hoc": adHoc}
		if messageSet {
			fields["user_message"] = message
		}
		if fiber, _, _, resolveErr := shuttleResolveFiberRef(args[0], true); resolveErr == nil {
			if block, ok, blockErr := fiber.ShuttleBlock(); blockErr != nil {
				return blockErr
			} else if ok && block != nil {
				owner, ownerErr := routeOwnerForCommand(cmd, args, block.Host)
				if ownerErr != nil {
					return ownerErr
				}
				if routed, routeErr := forwardDispatch(cmd, args, owner, fiber, fields); routed || routeErr != nil {
					return routeErr
				}
			}
		}
		request := map[string]any{"fiber_id": args[0], "ad_hoc": adHoc}
		if messageSet {
			request["user_message"] = message
		}
		payload, err := json.Marshal(request)
		if err != nil {
			return fmt.Errorf("encoding dispatch request: %w", err)
		}
		endpoint, err := daemonEndpoint("/api/v1/dispatch")
		if err != nil {
			return err
		}
		body, err := postDaemon(endpoint, payload, daemonPostTimeout)
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

var (
	dispatchMessage     string
	dispatchMessageFile string
)

func init() {
	shuttleDispatchCmd.Flags().Bool("ad-hoc", false, "For standing roles, dispatch an ad-hoc run without consuming the scheduled occurrence")
	shuttleDispatchCmd.Flags().StringVar(&dispatchMessage, "message", "", "Launch directive for the worker (the From User prompt block)")
	shuttleDispatchCmd.Flags().StringVar(&dispatchMessageFile, "message-file", "", "Read the launch directive from a file, or - for stdin")
	shuttleCmd.AddCommand(shuttleSnapshotCmd)
	shuttleCmd.AddCommand(shuttleDispatchCmd)
}
