package shuttlecli

import (
	"github.com/cailmdaley/felt/internal/harness"
	"github.com/spf13/cobra"
)

type sessionEnvelope struct {
	HookSpecificOutput sessionInner `json:"hookSpecificOutput"`
}

type sessionInner struct {
	HookEventName     string `json:"hookEventName"`
	AdditionalContext string `json:"additionalContext"`
}

func (a *app) hookCmd() *cobra.Command {
	hookCmd := &cobra.Command{
		Use:   "hook",
		Short: "Shuttle event and commit hook adapters",
		Long:  "Harness adapters that record Shuttle session events and commits for the daemon's activity stream.",
	}
	hookCmd.GroupID = groupOperations
	hookCmd.AddCommand(a.hookEventCmd(), a.hookInterruptedCmd(), a.hookCommitCmd(), a.hookHandoffCmd())
	return hookCmd
}

// harnessFor names the harness by the tree its transcript lives in; an empty
// or unrelated path identifies the Codex hook format.
func (a *app) harnessFor(transcriptPath string) string {
	if name := harness.ForTranscript(a.env, transcriptPath); name != "" {
		return harness.LedgerName(name)
	}
	return harness.LedgerName("codex")
}
