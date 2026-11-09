package shuttlecli

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

type standingTransitionRequest struct {
	Path         string `json:"path"`
	UID          string `json:"uid"`
	Host         string `json:"host"`
	DispatchedAt string `json:"dispatched_at"`
	RunID        string `json:"run_id"`
	Recovery     bool   `json:"recovery"`
}

type standingTransitionResult struct {
	Changed bool `json:"changed"`
}

func runtimeString(f *felt.Felt, key string) string {
	runtime := felt.MappingValueNode(f.ExtraFields["shuttle"], "runtime")
	node := felt.MappingValueNode(runtime, key)
	if node == nil {
		return ""
	}
	return node.Value
}

// Resolved YAML timestamps can omit trailing fractional zeros. Run identity
// compares their instants while retaining exact matches for unrecorded runs.
func sameDispatchInstant(observed, current string) bool {
	if observed == current {
		return true
	}
	at := shuttle.RuntimeTimestamp(observed)
	return !at.IsZero() && at.Equal(shuttle.RuntimeTimestamp(current))
}

// concludeStandingRun records the end of a standing run whose worker exited
// without handing off: handed_off_at is stamped, and the constitution stays
// armed for its schedule's next tick. The observation identifies the run; the
// owner, status and markers are read under the felt lock, so a newer run, a
// handoff or a human pause or retirement is left as it stands. A recovered
// exit (observed after a daemon restart) is stamped at its dispatch instant,
// so an occurrence that elapsed while the daemon was down still fires.
func concludeStandingRun(req standingTransitionRequest) (standingTransitionResult, error) {
	result := standingTransitionResult{}
	if req.Host == "" {
		return result, fmt.Errorf("expected host required")
	}
	_, err := felt.UpdateFiberFile(req.Path, idFromPath(req.Path), func(f *felt.Felt) error {
		block, ok, err := shuttle.BlockOf(f)
		if err != nil {
			return err
		}
		if !ok || block.Kind != "standing" {
			return fmt.Errorf("only applies to standing constitutions")
		}
		dispatchedAt := runtimeString(f, "dispatched_at")
		if block.Host != req.Host || f.UID != req.UID || !sameDispatchInstant(req.DispatchedAt, dispatchedAt) || runtimeString(f, "run_id") != req.RunID {
			return nil
		}
		dispatch := shuttle.RuntimeTimestamp(dispatchedAt)
		if f.Status != felt.StatusActive || dispatch.IsZero() || !shuttle.RuntimeTimestamp(runtimeString(f, "handed_off_at")).Before(dispatch) {
			return nil
		}
		at := time.Now().UTC()
		if req.Recovery {
			at = dispatch.UTC()
		}
		if err := shuttle.SetRuntimeField(f, "handed_off_at", at.Format(time.RFC3339Nano)); err != nil {
			return err
		}
		if err := shuttle.SetRuntimeField(f, "thread_exit_verb", "handed off"); err != nil {
			return err
		}
		evictStandingRuntimeKeys(f)
		result.Changed = true
		return nil
	})
	return result, err
}

func evictStandingRuntimeKeys(f *felt.Felt) {
	for _, key := range []string{"enabled", "review", "next_due_at", "last_run_at", "session"} {
		felt.RemoveMappingKey(f.ExtraFields["shuttle"], key)
	}
}

func (a *app) standingTransitionCmd() *cobra.Command {
	var request string
	cmd := &cobra.Command{Use: "conclude-run", Hidden: true, Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			var req standingTransitionRequest
			if err := json.Unmarshal([]byte(request), &req); err != nil {
				return err
			}
			result, err := concludeStandingRun(req)
			if err != nil {
				return err
			}
			return json.NewEncoder(a.env.Stdout).Encode(result)
		},
	}
	cmd.Flags().StringVar(&request, "request-json", "", "Conclude a standing run whose worker exited without handing off")
	return cmd
}
