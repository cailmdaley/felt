package shuttlecli

import (
	"bytes"
	"strings"
	"testing"
)

func TestMissingIndexerNeverFailsHarnessHook(t *testing.T) {
	env := testEnv(t)
	env.Set("PATH", t.TempDir())
	env.Set("SHUTTLE_MESSAGES", "off")
	env.Set("SHUTTLE_EVENTS", "off")
	for _, payload := range []string{
		`{"hook_event_name":"SessionEnd","harness":"codex","session_id":"test-session","transcript_path":"/transcripts/rollout.jsonl"}`,
		`{"hook_event_name":"SessionEnd","harness":"pi","session_id":"test-session"}`,
		`{"hook_event_name":"Stop","harness":"claude","session_id":"test-session","transcript_path":"/transcripts/session.jsonl"}`,
		`{malformed`,
	} {
		var output bytes.Buffer
		if err := newApp(env).runEventAndMessageHook(strings.NewReader(payload), &output); err != nil {
			t.Fatalf("hook failed for %s: %v", payload, err)
		}
		if output.Len() != 0 {
			t.Fatalf("advisory indexing wrote harness output: %s", output.String())
		}
	}
}
