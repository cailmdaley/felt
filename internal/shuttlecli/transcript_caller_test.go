package shuttlecli

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestTranscriptSearchCallerExclusions(t *testing.T) {
	base := indexedTranscriptEnv(t)
	base.Set("SHUTTLE_DAEMON_URL", "http://127.0.0.1:1")
	const claude = "11111111-1111-4111-8111-111111111111"
	const codex = "22222222-2222-4222-8222-222222222222"
	const pi = "33333333-3333-4333-8333-333333333333"
	for _, tc := range []struct {
		name   string
		env    map[string]string
		flags  []string
		absent []string
		count  int
	}{
		{name: "no caller", count: 3},
		{name: "claude export", env: map[string]string{"CLAUDE_CODE_SESSION_ID": claude}, absent: []string{claude}, count: 2},
		{name: "codex export", env: map[string]string{"CODEX_THREAD_ID": codex}, absent: []string{codex}, count: 2},
		{name: "pi export", env: map[string]string{"AI_AGENT": "pi", "PI_SESSION_ID": pi}, absent: []string{pi}, count: 2},
		{name: "nested pi excludes only self", env: map[string]string{"AI_AGENT": "pi", "PI_SESSION_ID": pi, "CLAUDE_CODE_SESSION_ID": claude, "CODEX_THREAD_ID": codex}, absent: []string{pi}, count: 2},
		{name: "include self", env: map[string]string{"CLAUDE_CODE_SESSION_ID": claude}, flags: []string{"--include-self"}, count: 3},
		{name: "explicit exclusions survive include self", env: map[string]string{"CLAUDE_CODE_SESSION_ID": claude}, flags: []string{"--include-self", "--exclude-session", claude, "--exclude-session", codex}, absent: []string{claude, codex}, count: 1},
		{name: "session selection intersects exclusion", env: map[string]string{"CLAUDE_CODE_SESSION_ID": claude}, flags: []string{"--session", claude}, count: 0},
		{name: "explicit session selection with include self", env: map[string]string{"CLAUDE_CODE_SESSION_ID": claude}, flags: []string{"--session", claude, "--include-self"}, count: 1},
		{name: "duplicate and unknown exclusions", flags: []string{"--exclude-session", claude, "--exclude-session", claude, "--exclude-session", "unknown"}, absent: []string{claude}, count: 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := base.Clone()
			for key, value := range tc.env {
				env.Set(key, value)
			}
			args := append([]string{"transcript", "search", "VMPZ convention", "--no-index", "--json"}, tc.flags...)
			out, _, err := executeIn(t, env, t.TempDir(), args...)
			if err != nil {
				t.Fatalf("search: %v %s", err, out)
			}
			var result transcriptSearchResult
			if err := json.Unmarshal([]byte(out), &result); err != nil {
				t.Fatal(err)
			}
			if len(result.Hits) != tc.count {
				t.Fatalf("hits=%d want=%d: %s", len(result.Hits), tc.count, out)
			}
			for _, hit := range result.Hits {
				for _, excluded := range tc.absent {
					if hit.Session == excluded {
						t.Fatalf("excluded session returned: %s", out)
					}
				}
			}
		})
	}
}

func TestTranscriptSearchMissingIndexGuidanceIsConditional(t *testing.T) {
	env := testEnv(t)
	env.Set("SHUTTLE_TRANSCRIPT_INDEX", t.TempDir()+"/index.sqlite")
	env.Set("SHUTTLE_DAEMON_URL", "http://127.0.0.1:1")
	_, _, err := executeIn(t, env, t.TempDir(), "transcript", "search", "needle")
	if err == nil || !strings.Contains(err.Error(), "when available") || !strings.Contains(err.Error(), "if no daemon is running") || !strings.Contains(err.Error(), "shuttle transcript index") {
		t.Fatalf("missing conditional guidance: %v", err)
	}
}
