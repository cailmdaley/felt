package shuttlecli

import (
	"encoding/json"
	"fmt"
	"strings"
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
	Action       string `json:"action"`
	Recovery     bool   `json:"recovery"`
}

type standingTransitionResult struct {
	Changed     bool                   `json:"changed"`
	Disposition shuttle.RunDisposition `json:"disposition"`
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

// The observation identifies the run, not a document image. The authoritative
// status, owner, human conclusion and content are read under the felt lock.
func applyStandingTransition(req standingTransitionRequest) (standingTransitionResult, error) {
	result := standingTransitionResult{}
	if req.Host == "" || (req.Action != "awaiting" && req.Action != "rearm") {
		return result, fmt.Errorf("expected host and standing transition action required")
	}
	_, err := felt.UpdateFiberFile(req.Path, idFromPath(req.Path), func(f *felt.Felt) error {
		block, ok, err := shuttle.BlockOf(f)
		if err != nil {
			return err
		}
		if !ok || block.Kind != "standing" {
			return fmt.Errorf("only applies to standing constitutions")
		}
		result.Disposition = shuttle.StandingRunDisposition(shuttle.RunFacts{DispatchedAt: runtimeString(f, "dispatched_at"), HandedOffAt: runtimeString(f, "handed_off_at"), ExitVerb: runtimeString(f, "thread_exit_verb")})
		if block.Host != req.Host || f.UID != req.UID || !sameDispatchInstant(req.DispatchedAt, runtimeString(f, "dispatched_at")) || runtimeString(f, "run_id") != req.RunID {
			if req.Action == "rearm" {
				return fmt.Errorf("standing run changed before force rearm")
			}
			return nil
		}
		if req.Action == "rearm" {
			if f.Status == felt.StatusActive {
				return nil
			}
			// Force-start is an explicit verdict. It preserves ask/blocked_on and
			// does not impose reopen's additional armability policy.
			if err := rearmStanding(f, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
				return err
			}
			evictStandingRuntimeKeys(f)
			result.Changed = true
			return nil
		}
		if f.Status != felt.StatusActive || f.ExtraFields["tempered"] != nil || result.Disposition == shuttle.RunRearmed {
			return nil
		}
		if req.Recovery && (result.Disposition == shuttle.RunUnrecorded || strings.HasPrefix(req.RunID, "adhoc-")) {
			return nil
		}
		if err := f.SetStatus(felt.StatusClosed, time.Now()); err != nil {
			return err
		}
		if err := f.SetExtraField("tempered", nil); err != nil {
			return err
		}
		if err := shuttle.SetRuntimeField(f, "thread_exit_verb", "closed"); err != nil {
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
	cmd := &cobra.Command{Use: "standing-transition", Hidden: true, Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			var req standingTransitionRequest
			if err := json.Unmarshal([]byte(request), &req); err != nil {
				return err
			}
			result, err := applyStandingTransition(req)
			if err != nil {
				return err
			}
			return json.NewEncoder(a.env.Stdout).Encode(result)
		},
	}
	cmd.Flags().StringVar(&request, "request-json", "", "Conditional standing-run transition")
	return cmd
}
