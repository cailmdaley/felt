package shuttlecli

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

type offlinePlanning struct {
	owner string
	uid   string
	path  string
	cause error
}

func (p *offlinePlanning) Error() string { return p.cause.Error() }
func (p *offlinePlanning) Unwrap() error { return p.cause }

// Planning changes a document without authorizing execution.
func planningCommand(cmd *cobra.Command, block *shuttle.Block) bool {
	switch cmd.Name() {
	case "close":
		flag := cmd.Flags().Lookup("tempered")
		return !(block.Kind == "standing" && flag != nil && flag.Value.String() == "true")
	case "pause", "rest", "set-agent", "set-model", "set-outcome", "role", "seat", "reshape":
		return true
	case "reopen":
		flag := cmd.Flags().Lookup("as-draft")
		return flag != nil && flag.Value.String() == "true"
	}
	return false
}

func planningTime(value any) (time.Time, bool) {
	switch value := value.(type) {
	case time.Time:
		return value, true
	case string:
		stamp, err := time.Parse(time.RFC3339Nano, value)
		return stamp, err == nil
	}
	return time.Time{}, false
}

func planningFiber(f *felt.Felt) bool {
	if f.Status == felt.StatusActive {
		return false
	}
	runtime := felt.MappingValueNode(f.ExtraFields[shuttle.FacetKey], shuttle.RuntimeKey)
	if runtime == nil {
		return true
	}
	var run map[string]any
	if runtime.Decode(&run) != nil {
		return false
	}
	value, hasDispatch := run["dispatched_at"]
	if !hasDispatch {
		return run["session_uuid"] == nil || run["session_uuid"] == ""
	}
	start, startOK := planningTime(value)
	end, endOK := planningTime(run["handed_off_at"])
	return startOK && endOK && end.After(start)
}

func (a *app) allowPlanningFallback(cmd *cobra.Command, f *felt.Felt, st *felt.Storage, block *shuttle.Block, reason error) bool {
	if st == nil || !planningCommand(cmd, block) {
		return false
	}
	var unknown unknownOwnerError
	retired := errors.As(reason, &unknown) && (cmd.Name() == "close" || cmd.Name() == "rest")
	if !planningFiber(f) && !retired {
		return false
	}
	if a.planningFallback == nil {
		a.planningFallback = &offlinePlanning{owner: block.Host, uid: f.UID, path: f.Path, cause: reason}
	}
	return true
}

// Ownership is resolved before selecting an offline write, including on a
// second read under the document lock after an unsent request.
func (a *app) lifecycleOwner(cmd *cobra.Command, args []string, f *felt.Felt, st *felt.Storage, block *shuttle.Block) (string, error) {
	if a.planningFallback != nil {
		if f.UID != a.planningFallback.uid || f.Path != a.planningFallback.path {
			return "", errors.New("document identity or physical path changed during arbitration; resolve the document again before retrying")
		}
		if block.Host != a.planningFallback.owner {
			return "", errors.New("execution owner changed during arbitration; ask the new owner before retrying")
		}
		if a.allowPlanningFallback(cmd, f, st, block, a.planningFallback) {
			return "", nil
		}
		return "", fmt.Errorf("%s can no longer be planned offline: the document has possible execution or no local storage", args[0])
	}
	localPlan := localOnly(cmd) && planningCommand(cmd, block)
	owner, err := a.routeOwner(cmd, args, block.Host, localOnly(cmd) && !localPlan)
	if localPlan && owner != "" && err == nil {
		reason := fmt.Errorf("explicit local document write for execution host %q", owner)
		if a.allowPlanningFallback(cmd, f, st, block, reason) {
			return "", nil
		}
		return a.routeOwner(cmd, args, block.Host, true)
	}
	var unknown unknownOwnerError
	if errors.As(err, &unknown) && a.allowPlanningFallback(cmd, f, st, block, err) {
		return "", nil
	}
	if err == nil && block.Host == "" {
		reason := unknownOwnerError{fmt.Errorf("no execution host is assigned")}
		if a.allowPlanningFallback(cmd, f, st, block, reason) {
			return "", nil
		}
		if planningCommand(cmd, block) {
			return "", fmt.Errorf("%w; no quiescent local planning copy is available", reason)
		}
	}
	return owner, err
}

func definitelyUnsent(err error) bool {
	var status daemonStatusError
	if errors.As(err, &status) {
		var response struct {
			Reason string `json:"reason"`
		}
		return json.Unmarshal([]byte(status.body), &response) == nil && response.Reason == "owner_unreachable_before_send"
	}
	var request *url.Error
	var dial *net.OpError
	return errors.As(err, &request) && errors.As(request.Err, &dial) && dial.Op == "dial"
}
