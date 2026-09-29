package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"sort"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

const maxLaunchMessageBytes = 64 << 10

// routeOwnerForCommand returns a remote owner only when the fiber's explicit
// shuttle.host differs from this host and is configured in remotes.json. An
// unknown or malformed fleet entry must fail before an origin-routed endpoint
// can degrade the request to this daemon's local mirror.
//
// Under --local nothing routes: the daemon shells every routing verb with it,
// so a daemon-run verb only ever writes a fiber this host owns, and a
// remote-owned one is refused with ownerMismatchError rather than sent back
// through the daemon.
func routeOwnerForCommand(cmd *cobra.Command, args []string, blockHost string) (string, error) {
	owner := strings.TrimSpace(blockHost)
	if owner == "" {
		return "", nil
	}
	own, source, err := resolveOwnHostSourced("")
	if err != nil {
		return "", fmt.Errorf("cannot verify fiber %s ownership: %w", args[0], err)
	}
	if owner == own {
		return "", nil
	}
	if localOnly(cmd) {
		return "", ownerMismatchError{fiber: args[0], owner: owner, own: own, source: source}
	}

	remotes, err := configuredRemotes()
	if err != nil {
		return "", ownerRouteRefusal(cmd, args, owner, fmt.Sprintf("cannot read the configured fleet: %v", err))
	}
	for _, remote := range remotes {
		if remote.Name == owner {
			return owner, nil
		}
	}
	path, _ := feltRemotesPath()
	return "", ownerRouteRefusal(cmd, args, owner,
		fmt.Sprintf("host %q is not an enabled remote in %s", owner, path))
}

// localFlagUsage is the one description of --local on every verb that can
// route to an owning daemon.
const localFlagUsage = "Write the document here and never route through a daemon; a fiber another host owns is refused"

// localOnly reports whether cmd runs with --local set.
func localOnly(cmd *cobra.Command) bool {
	flag := cmd.Flags().Lookup("local")
	return flag != nil && flag.Value.String() == "true"
}

func ownerRouteRefusal(cmd *cobra.Command, args []string, owner, reason string) error {
	command := directOwnerCommand(cmd, args)
	return fmt.Errorf("cannot route to owning host %q: %s. Run `%s` on that host, or configure it with `felt shuttle remotes add %s --port <local-tunnel-port>`", owner, reason, command, owner)
}

// directOwnerCommand gives the operator an actionable fallback without
// echoing launch-message text into an error or terminal log.
func directOwnerCommand(cmd *cobra.Command, args []string) string {
	parts := strings.Fields(cmd.CommandPath())
	for _, arg := range args {
		parts = append(parts, shellQuote(arg))
	}
	var flags []string
	cmd.Flags().Visit(func(flag *pflag.Flag) {
		if flag.Name == "help" || flag.Name == "json" || flag.Name == "directory" || flag.Name == "felt-store" {
			return
		}
		if flag.Name == "message" {
			flags = append(flags, "--message '[launch directive omitted]'")
			return
		}
		if flag.Name == "message-file" {
			if flag.Value.String() != flag.DefValue {
				flags = append(flags, "--message-file "+shellQuote(flag.Value.String()))
			}
			return
		}
		if flag.Value.String() == flag.DefValue {
			return
		}
		if flag.Value.Type() == "bool" {
			flags = append(flags, fmt.Sprintf("--%s=%s", flag.Name, flag.Value.String()))
			return
		}
		flags = append(flags, "--"+flag.Name+" "+shellQuote(flag.Value.String()))
	})
	sort.Strings(flags)
	return strings.Join(append(parts, flags...), " ")
}

func shellQuote(value string) string {
	if value != "" && strings.IndexFunc(value, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("_./:@+-", r))
	}) == -1 {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

// remoteRouteError maps the local-daemon-to-owner hop separately from a local
// daemon connection failure. A forwarding failure can happen after the owner
// accepted the request, so it must never be reported as a safe-to-repeat
// failure.
func remoteRouteError(cmd *cobra.Command, args []string, owner string, err error) error {
	command := directOwnerCommand(cmd, args)
	if detail, ok := ownerForwardFailure(err, owner); ok {
		return fmt.Errorf("owning host %q is unreachable (forward failed: %s); the action may have been applied. Check the fiber on %q before retrying. Run `%s` there if needed", owner, detail, owner, command)
	}

	var statusErr daemonStatusError
	if errors.As(err, &statusErr) {
		if statusErr.status == httpStatusBadGateway && dispatchAppLaunchUncertain(statusErr.body) {
			return fmt.Errorf("owning daemon %q responded, but the conversation or turn may already exist; inspect it before retrying: %s", owner, statusErr.body)
		}
		if strings.Contains(statusErr.body, "fiber ") && strings.Contains(statusErr.body, "is owned by host") {
			return ownerRouteRefusal(cmd, args, owner,
				fmt.Sprintf("the local daemon did not route this origin (its remote configuration may be stale): %s", statusErr.body))
		}
		if statusErr.status >= 500 {
			return fmt.Errorf("owning daemon %q responded with HTTP %d: %s; the action may have been applied. Check the fiber before retrying", owner, statusErr.status, statusErr.body)
		}
		return err
	}

	if !requestCouldHaveReachedDaemon(err) {
		return ownerRouteRefusal(cmd, args, owner,
			fmt.Sprintf("the local shuttle daemon is unreachable: %v; it did not receive the request", err))
	}
	return fmt.Errorf("could not confirm routing to owning host %q through the local shuttle daemon: %v; the action may have been applied. Check the fiber on %q before retrying. Run `%s` there if needed", owner, err, owner, command)
}

const httpStatusBadGateway = 502

func ownerForwardFailure(err error, owner string) (string, bool) {
	var statusErr daemonStatusError
	if !errors.As(err, &statusErr) || statusErr.status != httpStatusBadGateway {
		return "", false
	}
	body := strings.TrimSpace(statusErr.body)
	if strings.HasPrefix(body, "forward to "+owner+" failed:") {
		return strings.TrimSpace(strings.TrimPrefix(body, "forward to "+owner+" failed:")), true
	}
	var response struct {
		Reason string `json:"reason"`
		Origin string `json:"origin"`
		Error  string `json:"error"`
	}
	if json.Unmarshal([]byte(body), &response) == nil && response.Reason == "forward_failed" && (response.Origin == "" || response.Origin == owner) {
		return response.Error, true
	}
	if strings.Contains(strings.ToLower(body), "stale origin") || strings.Contains(body, "socket_closed_remotely") {
		return body, true
	}
	return "", false
}

func dispatchAppLaunchUncertain(body string) bool {
	var response struct {
		Reason string `json:"reason"`
	}
	return json.Unmarshal([]byte(body), &response) == nil && response.Reason == "app_launch_failed"
}

// A dial error means the local daemon never accepted the POST. Errors after
// connecting are ambiguous: the daemon may have forwarded the action before its
// response was lost.
func requestCouldHaveReachedDaemon(err error) bool {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		var opErr *net.OpError
		if errors.As(urlErr.Err, &opErr) && opErr.Op == "dial" {
			return false
		}
	}
	return strings.Contains(err.Error(), "reaching daemon") || strings.Contains(err.Error(), "reading daemon response")
}

func postOwnerLifecycle(action, owner string, fiber *felt.Felt, fields map[string]any) (string, error) {
	payload := map[string]any{"action": action, "fiber": fiber.ID, "origin": owner}
	for key, value := range fields {
		payload[key] = value
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("encoding lifecycle request: %w", err)
	}
	endpoint, err := daemonEndpoint("/api/v1/lifecycle")
	if err != nil {
		return "", err
	}
	response, err := postDaemon(endpoint, body, daemonLifecycleTimeout)
	if err != nil {
		return "", err
	}
	return string(response), nil
}

func postOwnerDispatch(owner string, fiber *felt.Felt, fields map[string]any) ([]byte, error) {
	payload := map[string]any{"fiber_id": fiber.ID, "origin": owner}
	for key, value := range fields {
		payload[key] = value
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encoding dispatch request: %w", err)
	}
	endpoint, err := daemonEndpoint("/api/v1/dispatch")
	if err != nil {
		return nil, err
	}
	return postDaemon(endpoint, body, daemonPostTimeout)
}

func forwardLifecycleAction(cmd *cobra.Command, args []string, owner, action string, fiber *felt.Felt, fields map[string]any) (bool, error) {
	if owner == "" {
		return false, nil
	}
	output, err := postOwnerLifecycle(action, owner, fiber, fields)
	if err != nil {
		return true, remoteRouteError(cmd, args, owner, err)
	}
	printDaemonBody([]byte(output))
	return true, nil
}

func forwardDispatch(cmd *cobra.Command, args []string, owner string, fiber *felt.Felt, fields map[string]any) (bool, error) {
	if owner == "" {
		return false, nil
	}
	body, err := postOwnerDispatch(owner, fiber, fields)
	if err != nil {
		return true, remoteRouteError(cmd, args, owner, err)
	}
	printDaemonBody(body)
	return true, nil
}

// readLaunchMessage implements the same bounded multiline input convention as
// `felt shuttle message`: one text source, either --message or --message-file.
func readLaunchMessage(cmd *cobra.Command, message, messageFile string) (text string, supplied bool, err error) {
	messageSet := cmd.Flags().Changed("message")
	fileSet := cmd.Flags().Changed("message-file")
	if messageSet && fileSet {
		return "", false, fmt.Errorf("--message and --message-file are mutually exclusive")
	}
	if messageSet {
		if len([]byte(message)) > maxLaunchMessageBytes {
			return "", false, fmt.Errorf("launch message exceeds %d bytes", maxLaunchMessageBytes)
		}
		return message, true, nil
	}
	if !fileSet {
		return "", false, nil
	}
	var reader io.Reader = cmd.InOrStdin()
	if messageFile != "-" {
		file, openErr := os.Open(messageFile)
		if openErr != nil {
			return "", false, fmt.Errorf("reading message file: %w", openErr)
		}
		defer file.Close()
		reader = file
	}
	data, readErr := io.ReadAll(io.LimitReader(reader, maxLaunchMessageBytes+1))
	if readErr != nil {
		return "", false, fmt.Errorf("reading launch message: %w", readErr)
	}
	if len(data) > maxLaunchMessageBytes {
		return "", false, fmt.Errorf("launch message exceeds %d bytes", maxLaunchMessageBytes)
	}
	return string(data), true, nil
}

// ownerBootQuarantine reads the local daemon's already owner-routed composite
// snapshot. A fresh remote snapshot in quarantine means an ordinary resume may
// remain pending until the operator releases that host; force-dispatch paths do
// not use this warning because they bypass the quarantine.
func ownerBootQuarantine(owner string) bool {
	endpoint, err := daemonEndpoint("/api/v1/state/composite")
	if err != nil {
		return false
	}
	body, err := getDaemon(endpoint, daemonReadTimeout)
	if err != nil {
		return false
	}
	var response struct {
		Remotes map[string]struct {
			Stale    bool `json:"stale"`
			Snapshot *struct {
				BootQuarantine bool `json:"boot_quarantine"`
			} `json:"snapshot"`
		} `json:"remotes"`
	}
	if json.Unmarshal(body, &response) != nil {
		return false
	}
	remote, ok := response.Remotes[owner]
	return ok && !remote.Stale && remote.Snapshot != nil && remote.Snapshot.BootQuarantine
}
