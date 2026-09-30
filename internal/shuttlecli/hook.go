package shuttlecli

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/spf13/cobra"
)

type sessionEnvelope struct {
	HookSpecificOutput sessionInner `json:"hookSpecificOutput"`
}

type sessionInner struct {
	HookEventName     string `json:"hookEventName"`
	AdditionalContext string `json:"additionalContext"`
}

var hookCmd = &cobra.Command{
	Use:   "hook",
	Short: "Shuttle event and commit hook adapters",
	Long:  "Harness adapters that record Shuttle session events and commits for the daemon's activity stream.",
}

func init() {
	hookCmd.GroupID = groupOperations
	addShuttleCommand(hookCmd)
	hookCmd.AddCommand(hookEventCmd, hookCommitCmd)
}

// harnessFor uses the transcript location shared by Claude Code and pi; an
// empty or unrelated path identifies the Codex hook format.
func harnessFor(transcriptPath string) string {
	home, _ := os.UserHomeDir()
	claudeDir := os.Getenv("CLAUDE_CONFIG_DIR")
	if claudeDir == "" {
		claudeDir = filepath.Join(home, ".claude")
	}
	for prefix, harness := range map[string]string{
		filepath.Join(claudeDir, "projects") + string(filepath.Separator): messaging.LedgerHarnessName("claude"),
		filepath.Join(home, ".pi") + string(filepath.Separator):           messaging.LedgerHarnessName("pi"),
	} {
		if transcriptPath != "" && strings.HasPrefix(transcriptPath, prefix) {
			return harness
		}
	}
	return messaging.LedgerHarnessName("codex")
}
