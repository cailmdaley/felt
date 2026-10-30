package shuttlecli

import (
	"encoding/json"
	"strconv"
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

func TestTranscriptMessagesCursorIsOpaqueDecimalAndValidated(t *testing.T) {
	env := testEnv(t)
	session := "11111111-2222-4333-8444-555555555555"
	out, _, err := executeIn(t, env, t.TempDir(), "transcript", "messages", session, "--json", "--since", "123")
	if err != nil {
		t.Fatal(err)
	}
	var response struct {
		Cursor   string `json:"cursor"`
		Messages []any  `json:"messages"`
	}
	if err := json.Unmarshal([]byte(out), &response); err != nil {
		t.Fatal(err)
	}
	if n, err := strconv.ParseInt(response.Cursor, 10, 64); err != nil || n <= 0 || response.Messages == nil {
		t.Fatalf("invalid response: %s", out)
	}
	for _, invalid := range []string{"-1", "abc", "9223372036854775808"} {
		if _, _, err := executeIn(t, env, t.TempDir(), "transcript", "messages", session, "--json", "--since", invalid); err == nil {
			t.Fatalf("accepted cursor %q", invalid)
		}
	}
}
