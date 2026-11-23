package shuttlecli

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

// The daemon-coupled passthrough verbs: snapshot (raw GET /api/v1/state) and
// dispatch (POST /api/v1/dispatch). Unlike the local-read verbs (status/ps), which
// felt now answers from its own data model, these query the running OTP daemon's
// live runtime state, which has no felt-internal analogue — so they stay thin
// passthroughs over the shared daemon transport in shuttle_daemon.go, printing
// whatever the daemon said.

func (a *app) shuttleSnapshotCmd() *cobra.Command {
	shuttleSnapshotCmd := &cobra.Command{
		Use:   "snapshot",
		Short: "Print the local daemon's state snapshot",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			endpoint, err := a.daemonEndpoint("/api/v1/state")
			if err != nil {
				return err
			}
			body, err := a.getDaemon(endpoint, daemonReadTimeout)
			if err != nil {
				return err
			}
			a.printDaemonBody(body)
			return nil
		},
	}
	return shuttleSnapshotCmd
}

func (a *app) shuttleDispatchCmd() *cobra.Command {
	var dispatchMessage string
	var dispatchMessageFile string
	var dispatchCarry bool
	shuttleDispatchCmd := &cobra.Command{
		Use:   "dispatch <fiber>",
		Short: "Ask the owning daemon to dispatch a fiber now",
		Long: `Routes a remote-owned fiber through this host's daemon to the owner.
Use --message or --message-file to add a launch directive (the From User prompt block).
Run from inside an agent session, the directive is that session's: it is
headed with the sender, recorded as its message rather than the human's, and
does not answer a question the fiber put to anyone else.

A remote dispatch carries this host's copy of the constitution. An owner whose
own copy already holds the constitution (its shuttle: block names the owner)
keeps that copy and says how this one differs; --carry sends this host's
version anyway. An owner whose copy has no block, or a block for another host,
takes this host's version first. An owner without the fiber has it created
from this host's copy, which stays here, and then dispatches it.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			adHoc, _ := cmd.Flags().GetBool("ad-hoc")
			message, messageSet, err := a.readLaunchMessage(cmd, dispatchMessage, dispatchMessageFile)
			if err != nil {
				return err
			}
			fields := map[string]any{"ad_hoc": adHoc}
			release, _ := cmd.Flags().GetBool("release-launch-reservation")
			if release {
				fmt.Fprintln(a.env.Stderr, "WARNING: Releasing an uncertain launch reservation may create a duplicate worker.")
				fields["release_launch_reservation"] = true
				fields["force"] = true
			}
			if messageSet {
				fields["user_message"] = message
			}
			// A session's dispatch (with or without a message) is that agent's
			// action, not the human's.
			if caller := a.messageCaller(); caller != "" {
				fields["from"] = caller
				if replyTo := a.messageReplyTarget(caller); replyTo != "" {
					fields["reply_to"] = replyTo
				}
			}
			address := args[0]
			if fiber, st, _, resolveErr := a.shuttleResolveFiberRef(args[0], true); resolveErr == nil {
				address = fiberAddress(fiber)
				if block, ok, blockErr := shuttle.BlockOf(fiber); blockErr != nil {
					return blockErr
				} else if ok && block != nil {
					owner, ownerErr := a.routeOwnerForCommand(cmd, args, block.Host)
					if ownerErr != nil {
						return ownerErr
					}
					if owner != "" {
						if st == nil {
							_, err := a.forwardDispatch(cmd, args, owner, fiber, fields)
							return err
						}
						return a.dispatchCarried(cmd, args, owner, fiber, block, fields, dispatchCarry)
					}
				}
			}
			request := map[string]any{"fiber_id": address}
			for key, value := range fields {
				request[key] = value
			}
			payload, err := json.Marshal(request)
			if err != nil {
				return fmt.Errorf("encoding dispatch request: %w", err)
			}
			endpoint, err := a.daemonEndpoint("/api/v1/dispatch")
			if err != nil {
				return err
			}
			body, err := a.postDaemon(endpoint, payload, daemonPostTimeout)
			if err != nil {
				return err
			}
			a.printDaemonBody(body)
			return nil
		},
	}
	shuttleDispatchCmd.Flags().Bool("release-launch-reservation", false, "Release an uncertain launch reservation and dispatch manually; a duplicate worker is possible")
	shuttleDispatchCmd.Flags().Bool("ad-hoc", false, "For standing constitutions, dispatch an ad-hoc run without consuming the scheduled occurrence")
	shuttleDispatchCmd.Flags().StringVar(&dispatchMessage, "message", "", "Launch directive for the worker (the From User prompt block)")
	shuttleDispatchCmd.Flags().StringVar(&dispatchMessageFile, "message-file", "", "Read the launch directive from a file, or - for stdin")
	shuttleDispatchCmd.Flags().BoolVar(&dispatchCarry, "carry", false, carryFlagUsage)
	return shuttleDispatchCmd
}

// dispatchCarried sends a remote dispatch carrying this host's document. An
// owner without the fiber gets it created from this host's copy, which stays
// here, and the dispatch is sent again.
func (a *app) dispatchCarried(cmd *cobra.Command, args []string, owner string, fiber *felt.Felt, block *shuttle.Block, fields map[string]any, carry bool) error {
	carried := map[string]any{"fiber_path": fiberPathHint(fiber)}
	for key, value := range fields {
		carried[key] = value
	}
	if err := carryDocument(carried, fiber, carry); err != nil {
		return err
	}
	body, err := a.postOwnerDispatch(owner, fiber, carried)
	if err != nil && ownerFiberMissing(err, owner) {
		created := *fiber
		if created.Status == "" {
			created.Status = felt.StatusOpen
		}
		if err := a.createRemoteFiber(owner, &created, block); err != nil {
			return remoteRouteError(cmd, args, owner, err)
		}
		fmt.Fprintf(a.env.Stdout, "created %s on %s from this host's copy\n", created.ID, owner)
		body, err = a.postOwnerDispatch(owner, &created, fields)
	}
	if err != nil {
		return remoteRouteError(cmd, args, owner, err)
	}
	a.printDispatchBody(body)
	return nil
}

// printDaemonBody echoes a daemon response verbatim, adding the newline the
// daemon may not have sent so the shell prompt does not land mid-line.
func (a *app) printDaemonBody(body []byte) {
	fmt.Fprint(a.env.Stdout, string(body))
	if !bytes.HasSuffix(body, []byte("\n")) {
		fmt.Fprintln(a.env.Stdout)
	}
}
