package shuttlecli

import (
	"encoding/json"
	"testing"
)

func TestClaudeStopWithBackgroundTasksIsIdleButCodexRemainsWorking(t *testing.T) {
	for _, tc := range []struct{ harness, want string }{{"claude", "idle"}, {"codex", "working"}} {
		input := eventHookInput{Harness: tc.harness, HookEventName: "Stop", BackgroundTasks: json.RawMessage(`[{"status":"running"}]`)}
		if got := turnMailboxState(input); got != tc.want {
			t.Fatalf("%s Stop state=%s want=%s", tc.harness, got, tc.want)
		}
	}
}
