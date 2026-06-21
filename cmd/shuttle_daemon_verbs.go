package cmd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

// The daemon-coupled passthrough verbs: snapshot (raw GET /api/v1/state) and
// dispatch (POST /api/v1/dispatch). Unlike the local-read verbs (status/ps), which
// felt now answers from its own data model, these query the running OTP daemon's
// live runtime state, which has no felt-internal analogue — so they stay thin HTTP
// clients, ported unchanged from shuttle-ctl so the daemon contract is identical
// under the transitional shim.

var shuttleSnapshotCmd = &cobra.Command{
	Use:   "snapshot",
	Short: "Print the local daemon's state snapshot",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		body, err := getDaemon(daemonURL() + "/api/v1/state")
		if err != nil {
			return err
		}
		fmt.Print(string(body))
		if !bytes.HasSuffix(body, []byte("\n")) {
			fmt.Println()
		}
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
		body, err := postDaemon(daemonURL()+"/api/v1/dispatch", payload)
		if err != nil {
			return err
		}
		fmt.Print(string(body))
		if !bytes.HasSuffix(body, []byte("\n")) {
			fmt.Println()
		}
		return nil
	},
}

func getDaemon(url string) ([]byte, error) {
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return nil, fmt.Errorf("reaching daemon at %s: %w", url, err)
	}
	defer resp.Body.Close()
	return readDaemonResponse(url, resp)
}

func postDaemon(url string, payload []byte) ([]byte, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Post(url, "application/json", bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("reaching daemon at %s: %w", url, err)
	}
	defer resp.Body.Close()
	return readDaemonResponse(url, resp)
}

func readDaemonResponse(url string, resp *http.Response) ([]byte, error) {
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading daemon response from %s: %w", url, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("daemon at %s returned %d: %s", url, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return body, nil
}

func init() {
	shuttleDispatchCmd.Flags().Bool("ad-hoc", false, "For standing roles, dispatch an ad-hoc run without consuming the scheduled occurrence")
	shuttleCmd.AddCommand(shuttleSnapshotCmd)
	shuttleCmd.AddCommand(shuttleDispatchCmd)
}
