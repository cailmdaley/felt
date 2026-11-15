package shuttlecli

import (
	"strings"
	"testing"
)

func TestMessageRecordedRequiresLocal(t *testing.T) {
	cmd := NewRootCmd(testEnv(t))
	cmd.SetArgs([]string{"message", "--recorded", "shuttle://remote/codex/session", "tick"})
	err := cmd.Execute()
	if err == nil || !strings.Contains(err.Error(), "--recorded requires --local") {
		t.Fatalf("want local-only refusal, got %v", err)
	}
}
