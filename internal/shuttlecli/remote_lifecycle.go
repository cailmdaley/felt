package shuttlecli

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
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

const maxLaunchMessageBytes = 64 << 10

type unknownOwnerError struct{ error }

// routeOwnerForCommand returns a remote owner only when the fiber's explicit
// shuttle.host differs from this host and names a remote in the resolved
// fleet: remotes.json or a tailnet peer the local daemon discovered. An
// unknown or malformed fleet entry must fail before an origin-routed endpoint
// can degrade the request to this daemon's local mirror.
//
// Under --local execution changes refuse a foreign owner rather than routing
// back through the daemon. lifecycleOwner separately validates the daemon's
// mirror exit after an owner cannot arbitrate.
func (a *app) routeOwnerForCommand(cmd *cobra.Command, args []string, blockHost string) (string, error) {
	owner, err := a.routeOwner(cmd, args, blockHost, localOnly(cmd))
	var unknown unknownOwnerError
	if !localOnly(cmd) && exitCommand(cmd) && errors.As(err, &unknown) {
		return blockHost, nil // Only the daemon may authorize the absent-owner exit.
	}
	return owner, err
}

func (a *app) routeOwner(cmd *cobra.Command, args []string, blockHost string, local bool) (string, error) {
	owner := strings.TrimSpace(blockHost)
	if owner == "" {
		return "", nil
	}
	own, source, err := a.resolveOwnHostSourced("")
	if err != nil {
		return "", fmt.Errorf("cannot verify fiber %s ownership: %w", args[0], err)
	}
	if owner == own {
		return "", nil
	}
	if local {
		return "", ownerMismatchError{fiber: args[0], owner: owner, own: own, source: source, hostFile: a.hostConfigFilePath()}
	}

	// The file answers first, so a configured owner costs no daemon read.
	doc, err := a.loadRemotesFile()
	if err != nil {
		return "", ownerRouteRefusal(cmd, args, owner, fmt.Sprintf("cannot read the configured fleet: %v", err))
	}
	for _, remote := range a.resolveRemotes(doc, nil) {
		if remote.Name == owner {
			return owner, nil
		}
	}
	path, _ := a.shuttleRemotesPath()
	reason := fmt.Sprintf("host %q is neither an enabled remote in %s nor a discovered tailnet peer", owner, path)
	discoveryFailed := false
	if doc.discoverEnabled() {
		discovery, err := a.fetchDaemonDiscovery()
		if err != nil {
			discoveryFailed = true
			reason += fmt.Sprintf(" (discovered peers unknown: %v)", err)
		} else {
			// A successful discovery can still omit an aged-out unreachable peer.
			discoveryFailed = true
			for _, remote := range a.admitDiscovered(doc, discovery.Peers) {
				if remote.Name == owner {
					return owner, nil
				}
			}
		}
	}
	refusal := ownerRouteRefusal(cmd, args, owner, reason)
	if !discoveryFailed {
		return "", unknownOwnerError{refusal}
	}
	return "", refusal
}

// localFlagUsage is the one description of --local on every verb that can
// route to an owning daemon.
const localFlagUsage = "Write here without routing; only safe foreign exits can travel by Git"

// localOnly reports whether cmd runs with --local set.
func localOnly(cmd *cobra.Command) bool {
	flag := cmd.Flags().Lookup("local")
	return flag != nil && flag.Value.String() == "true"
}

func ownerRouteRefusal(cmd *cobra.Command, args []string, owner, reason string) error {
	command := directOwnerCommand(cmd, args)
	return fmt.Errorf("cannot route to owning host %q: %s. Run `%s` on that host, or configure it with `shuttle remotes add %s --port <local-tunnel-port>` or edit shuttle.host in the fiber", owner, reason, command, owner)
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
		if flag.Name == "help" || flag.Name == "json" || flag.Name == "store" {
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
	var preflight ownerPreflightError
	if errors.As(err, &preflight) {
		return err
	}
	var moved movedDraftError
	if errors.As(err, &moved) {
		return err
	}
	command := directOwnerCommand(cmd, args)
	var notSent daemonStatusError
	if errors.As(err, &notSent) {
		var response struct {
			Reason string `json:"reason"`
			Error  string `json:"error"`
		}
		if json.Unmarshal([]byte(notSent.body), &response) == nil && response.Reason == "owner_unreachable_before_send" {
			return fmt.Errorf("%s; retry when the owner is reachable", response.Error)
		}
	}
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
			fmt.Sprintf("the local shuttle daemon is unreachable: %v; it did not receive the request. Start it, or use --local for an explicit local exit", err))
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

func ownerFiberMissing(err error, owner string) bool {
	var preflight ownerPreflightError
	if errors.As(err, &preflight) {
		return false
	}
	var response daemonStatusError
	if !errors.As(err, &response) || response.status != 404 {
		return false
	}
	var missing struct {
		Code string `json:"error_code"`
		Host string `json:"host"`
	}
	return json.Unmarshal([]byte(response.body), &missing) == nil && missing.Code == "fiber_not_found" && missing.Host == owner
}

// fiberAddress carries intrinsic identity across hosts, independent of store views.
func fiberAddress(f *felt.Felt) string {
	if f.UID != "" {
		return f.UID
	}
	return fiberPathHint(f)
}

func fiberPathHint(f *felt.Felt) string {
	if rel, err := feltStoreRelativePath(f.Path); err == nil {
		if id, err := fiberIDFromStorePath(rel); err == nil {
			return id
		}
	}
	return f.ID
}

func (a *app) postOwnerLifecycle(action, owner string, fiber *felt.Felt, fields map[string]any) (string, error) {
	if action == "resume" {
		if _, changesProject := fields["project_dir"]; changesProject {
			if err := a.requireOwnerNamespaceContract(owner); err != nil {
				return "", ownerPreflightError{err}
			}
		}
	}
	payload := map[string]any{"action": action, "fiber": fiberAddress(fiber), "origin": owner, "fiber_path": fiberPathHint(fiber)}
	for key, value := range fields {
		payload[key] = value
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("encoding lifecycle request: %w", err)
	}
	endpoint, err := a.daemonEndpoint("/api/v1/lifecycle")
	if err != nil {
		return "", err
	}
	response, err := a.postRouted(owner, endpoint, body)
	if err != nil {
		return "", err
	}
	return string(response), nil
}

// postOwnerFiberCreate sends a complete fiber document through the local
// daemon's owner-routed create endpoint. The destination daemon owns placement
// and validates any armed project_dir against its own filesystem.
func (a *app) postOwnerFiberCreate(owner string, payload map[string]any) ([]byte, error) {
	if err := a.requireOwnerNamespaceContract(owner); err != nil {
		return nil, ownerPreflightError{err}
	}
	payload["origin"] = owner
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encoding fiber create request: %w", err)
	}
	endpoint, err := a.daemonEndpoint("/api/v1/fiber/create")
	if err != nil {
		return nil, err
	}
	return a.postRouted(owner, endpoint, body)
}

// ownerPreflightError is a read-only refusal, not a failed mutation POST.
// Keep its phase when routing errors or deciding whether a draft may transfer.
type ownerPreflightError struct{ err error }

func (e ownerPreflightError) Error() string {
	return fmt.Sprintf("%v; the guarded write request was not sent", e.err)
}
func (e ownerPreflightError) Unwrap() error { return e.err }

const ownerNamespaceContractLevel = 31

// Namespace creation and resume's project-dir patch require the owner's
// protocol, not the hub's build or an archived peer report.
func (a *app) requireOwnerNamespaceContract(owner string) error {
	endpoint, err := a.daemonEndpoint("/api/v1/version")
	if err != nil {
		return err
	}
	body, err := a.getDaemon(endpoint+"?origin="+url.QueryEscape(owner), daemonPostTimeout)
	if err != nil {
		return fmt.Errorf("checking namespace contract on owner %q: %w", owner, err)
	}
	var version struct {
		Host     string `json:"host"`
		Level    int    `json:"contract_level"`
		Contract struct {
			Expected int `json:"expected"`
		} `json:"contract"`
	}
	if err := json.Unmarshal(body, &version); err != nil {
		return fmt.Errorf("cannot verify namespace contract on owner %q; deploy it before cross-host writes: %w", owner, err)
	}
	if version.Level == 0 {
		version.Level = version.Contract.Expected
	}
	if version.Host != owner || version.Level < ownerNamespaceContractLevel {
		return fmt.Errorf("owner %q requires contract level %d for cross-host namespace writes (reported host %q, level %d); deploy the owner and routing daemon before retrying", owner, ownerNamespaceContractLevel, version.Host, version.Level)
	}
	return nil
}

func (a *app) postOwnerDispatch(owner string, fiber *felt.Felt, fields map[string]any) ([]byte, error) {
	payload := map[string]any{"fiber_id": fiberAddress(fiber), "origin": owner}
	for key, value := range fields {
		payload[key] = value
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encoding dispatch request: %w", err)
	}
	endpoint, err := a.daemonEndpoint("/api/v1/dispatch")
	if err != nil {
		return nil, err
	}
	return a.postRouted(owner, endpoint, body)
}

// postRouted sends a write the local daemon forwards to owner. It waits out the
// whole forwarding ladder (daemonRoutedPostTimeout), and says on stderr what it
// is waiting for once the wait is long enough to look like a hang.
func (a *app) postRouted(owner, endpoint string, body []byte) ([]byte, error) {
	notice := time.AfterFunc(routedWaitNotice, func() {
		fmt.Fprintf(a.env.Stderr, "waiting for %s's daemon (up to %s)…\n", owner, daemonRoutedPostTimeout)
	})
	defer notice.Stop()
	return a.postDaemon(endpoint, body, daemonRoutedPostTimeout)
}

// routedWaitNotice is how long a routed write runs before the CLI says what it
// is waiting for. Ordinary routed writes answer well within it.
const routedWaitNotice = 3 * time.Second

func (a *app) forwardLifecycleAction(cmd *cobra.Command, args []string, owner, action string, fiber *felt.Felt, fields map[string]any) (bool, error) {
	if owner == "" {
		return false, nil
	}
	// The owner or the hub's offline writer may take this same document lock.
	if err := a.unlockDocument(); err != nil {
		return true, err
	}
	output, err := a.postOwnerLifecycle(action, owner, fiber, fields)
	if err != nil {
		return true, remoteRouteError(cmd, args, owner, err)
	}
	a.printDaemonBody([]byte(output))
	return true, nil
}

func (a *app) forwardDispatch(cmd *cobra.Command, args []string, owner string, fiber *felt.Felt, fields map[string]any) (bool, error) {
	if owner == "" {
		return false, nil
	}
	body, err := a.postOwnerDispatch(owner, fiber, fields)
	if err != nil {
		return true, remoteRouteError(cmd, args, owner, err)
	}
	a.printDaemonBody(body)
	return true, nil
}

// readLaunchMessage implements the same bounded multiline input convention as
// `shuttle message`: one text source, either --message or --message-file.
func (a *app) readLaunchMessage(cmd *cobra.Command, message, messageFile string) (text string, supplied bool, err error) {
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
		file, openErr := os.Open(a.env.Resolve(messageFile))
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

// ownerBootQuarantine reads the owning daemon's fresh composite snapshot.
// A snapshot in quarantine means an ordinary resume may
// remain pending until the operator releases that host; force-dispatch paths do
// not use this warning because they bypass the quarantine.
func (a *app) ownerBootQuarantine(owner string) bool {
	composite, err := a.fetchComposite()
	if err != nil {
		return false
	}
	snapshot := a.ownerSnapshot(composite, owner)
	return snapshot != nil && snapshot.BootQuarantine
}
