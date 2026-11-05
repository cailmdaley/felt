package shuttlecli

import (
	"errors"
	"fmt"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

func addMirrorOwnerFlag(cmd *cobra.Command) {
	cmd.Flags().String("mirror-owner", "", "Require this execution owner for a daemon-authorized local exit")
	_ = cmd.Flags().MarkHidden("mirror-owner")
}

func exitCommand(cmd *cobra.Command) bool {
	return cmd.Name() == "rest" || cmd.Name() == "pause" || cmd.Name() == "close" && cmd.Flag("tempered").Value.String() != "true"
}

// Quoted and bare YAML timestamps follow the same RFC3339 rule.
func planningFiber(f *felt.Felt) bool {
	if f.Status == felt.StatusActive {
		return false
	}
	runtime := felt.MappingValueNode(f.ExtraFields[shuttle.FacetKey], shuttle.RuntimeKey)
	if runtime == nil {
		return true
	}
	if runtime.Kind != yaml.MappingNode {
		return false
	}
	start := felt.MappingValueNode(runtime, "dispatched_at")
	if start == nil {
		return runtimeString(f, "session_uuid") == ""
	}
	a := shuttle.RuntimeTimestamp(start.Value)
	b := shuttle.RuntimeTimestamp(runtimeString(f, "handed_off_at"))
	return !a.IsZero() && b.After(a)
}

// The daemon alone selects automatic fallback. --local is an explicit write;
// its foreign exits recheck quiescence under the document lock.
func (a *app) lifecycleOwner(cmd *cobra.Command, args []string, f *felt.Felt, st *felt.Storage, block *shuttle.Block) (string, error) {
	if flag := cmd.Flags().Lookup("mirror-owner"); flag != nil && flag.Changed {
		if !localOnly(cmd) || flag.Value.String() != block.Host || !exitCommand(cmd) {
			return "", fmt.Errorf("execution owner changed or exit not authorized; no mirror write")
		}
	}
	if !localOnly(cmd) {
		return a.routeOwnerForCommand(cmd, args, block.Host)
	}
	owner, err := a.routeOwner(cmd, args, block.Host, false)
	var unknown unknownOwnerError
	removed := errors.As(err, &unknown) && block.Host != ""
	if exitCommand(cmd) && st != nil && (owner != "" || removed || block.Host == "") {
		if (!planningFiber(f) && !removed) || (block.Kind == "standing" && block.Schedule != nil && !removed) {
			_, refusal := a.routeOwner(cmd, args, block.Host, true)
			if refusal == nil {
				refusal = fmt.Errorf("no execution host is assigned")
			}
			return "", fmt.Errorf("execution owner decides: no safe local exit for %s: %w", args[0], refusal)
		}
		runtime := felt.MappingValueNode(f.ExtraFields[shuttle.FacetKey], shuttle.RuntimeKey)
		if runtime != nil && runtime.Kind != yaml.MappingNode {
			return "", fmt.Errorf("malformed runtime; no mirror write")
		}
		a.localMirror = true
		return "", nil
	}
	return a.routeOwner(cmd, args, block.Host, true)
}
