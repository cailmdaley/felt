package shuttlecli

import (
	"strings"
	"testing"
)

func TestTranscriptMessagesReadsOfflineAndRejectsInvalidSession(t *testing.T) {
	env := testEnv(t)
	env.Set("SHUTTLE_DAEMON_URL", "http://127.0.0.1:1")
	out, _, err := executeIn(t, env, t.TempDir(), "transcript", "messages", "11111111-2222-4333-8444-555555555555", "--json")
	if err != nil || !strings.Contains(out, `"messages": []`) {
		t.Fatalf("offline message evidence: %s %v", out, err)
	}
	if _, _, err := executeIn(t, env, t.TempDir(), "transcript", "messages", "../../invalid", "--json"); err == nil {
		t.Fatal("accepted invalid session")
	}
}
