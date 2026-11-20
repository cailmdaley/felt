package shuttlecli

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/cailmdaley/felt/internal/messaging"
)

// The hook payloads Claude Code 2.1 and Codex 0.167 sent in recorded sessions,
// from the shared conformance fixtures, replayed through `shuttle hook event`
// as the plugin's event.sh hands them over. With the shim naming its harness,
// every event is recorded and registered under it even where the transcript
// path says nothing. Without it, as from a shim installed before shims named
// their harness, the transcript path still decides.
func TestRecordedClaudeAndCodexHooksRecordTheirHarness(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct{ harness, ledger, session string }{
		{"claude", "claude-code", "f0ef736f-d4ce-4ea6-b13a-3d36abbab0de"},
		{"codex", "codex", "01a1f6df-f695-7e23-926e-53b5642d0d55"},
	} {
		for _, named := range []bool{true, false} {
			name := tc.harness + "/named"
			if !named {
				name = tc.harness + "/inferred"
			}
			t.Run(name, func(t *testing.T) {
				t.Parallel()
				env := messageHookEnv(t, "host")
				events := filepath.Join(t.TempDir(), "events.jsonl")
				env.Set("SHUTTLE_EVENTS", "")
				env.Set("SHUTTLE_EVENTS_FILE", events)
				if named {
					// No root matches the recorded paths: only the shim's name can say.
					env.Set("SHUTTLE_CLAUDE_PROJECTS_DIR", t.TempDir())
					env.Set("SHUTTLE_CODEX_SESSIONS_DIR", t.TempDir())
					env.Set("SHUTTLE_HOOK_HARNESS", tc.harness)
				} else {
					env.Set("SHUTTLE_CLAUDE_PROJECTS_DIR", "/home/user/.claude/projects")
					env.Set("SHUTTLE_CODEX_SESSIONS_DIR", "/home/user/.codex/sessions")
				}
				names, err := filepath.Glob(filepath.Join("..", "..", "daemon", "test", "fixtures", "harnesses", tc.harness, "hooks", "*.json"))
				if err != nil || len(names) == 0 {
					t.Fatalf("no recorded hooks: %v", err)
				}
				sort.Strings(names)
				registered := false
				for _, name := range names {
					payload, err := os.ReadFile(name)
					if err != nil {
						t.Fatal(err)
					}
					if err := newApp(env).runEventAndMessageHook(bytes.NewReader(payload), &bytes.Buffer{}); err != nil {
						t.Fatal(err)
					}
					if _, err := messaging.MailboxState(env, tc.harness, tc.session, "host"); err == nil {
						registered = true
					}
				}
				if !registered {
					t.Fatalf("%s session never registered a %s mailbox", tc.session, tc.harness)
				}
				file, err := os.Open(events)
				if err != nil {
					t.Fatal(err)
				}
				defer file.Close()
				lines := 0
				for scanner := bufio.NewScanner(file); scanner.Scan(); lines++ {
					var line struct{ Type, Harness string }
					if err := json.Unmarshal(scanner.Bytes(), &line); err != nil {
						t.Fatal(err)
					}
					if line.Harness != tc.ledger {
						t.Errorf("%s event recorded as %q, want %q", line.Type, line.Harness, tc.ledger)
					}
				}
				if lines != len(names) {
					t.Fatalf("recorded %d events from %d hooks", lines, len(names))
				}
			})
		}
	}
}
