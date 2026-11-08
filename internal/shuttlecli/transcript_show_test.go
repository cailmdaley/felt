package shuttlecli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// showFixture indexes one Claude session: a conversation about a fish recipe
// with tool calls between turns and an ai-title, and a subagent whose brief
// also mentions the recipe.
func showFixture(t *testing.T) func(args ...string) (string, error) {
	t.Helper()
	e := testEnv(t)
	dir := t.TempDir()
	store := filepath.Join(dir, "store")
	if err := os.MkdirAll(filepath.Join(store, ".felt"), 0o755); err != nil {
		t.Fatal(err)
	}
	const session = "abcdef01-2222-4333-8444-555555555555"
	project := filepath.Join(dir, "claude", "-kitchen")
	sub := filepath.Join(project, session, "subagents")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	rec := func(kind, ts, content string) string {
		c, _ := json.Marshal(content)
		return fmt.Sprintf(`{"type":%q,"sessionId":%q,"cwd":"/kitchen","timestamp":%q,"message":{"role":%q,"content":%s}}`, kind, session, ts, kind, c)
	}
	tool := fmt.Sprintf(`{"type":"assistant","sessionId":%q,"cwd":"/kitchen","timestamp":"2026-10-25T10:00:30Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{"file_path":"/kitchen/notes.md"}}]}}`, session)
	main := []string{
		rec("user", "2026-10-25T10:00:00Z", "What should we cook tonight?"),
		tool, tool,
		rec("assistant", "2026-10-25T10:01:00Z", "Something with the sea bass from the market."),
		rec("user", "2026-10-25T10:02:00Z", "Base directory for this skill: /skills/cook"),
		rec("user", "2026-10-25T10:03:00Z", "Write down the fish recipe."),
		rec("assistant", "2026-10-25T10:04:00Z", "The fish recipe: slash, salt, roast whole at 220°C."),
		rec("user", "2026-10-25T10:05:00Z", "And a side?"),
		rec("assistant", "2026-10-25T10:06:00Z", "Charred leeks."),
		`{"type":"ai-title","aiTitle":"Bar rôti for dinner","sessionId":"` + session + `"}`,
	}
	if err := os.WriteFile(filepath.Join(project, session+".jsonl"), []byte(strings.Join(main, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	brief := rec("user", "2026-10-25T10:03:30Z", "Check the fish recipe against the fish recipe book: fish recipe, fish recipe.")
	if err := os.WriteFile(filepath.Join(sub, "agent-acheck-9f8e7d6c5b4a3921.jsonl"), []byte(brief+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "agent-acheck-9f8e7d6c5b4a3921.meta.json"), []byte(`{"description":"Check the recipe"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	e.Set("SHUTTLE_CLAUDE_PROJECTS_DIR", filepath.Join(dir, "claude"))
	e.Set("SHUTTLE_CODEX_SESSIONS_DIR", filepath.Join(dir, "codex"))
	e.Set("SHUTTLE_PI_SESSIONS_DIR", filepath.Join(dir, "pi"))
	e.Set("SHUTTLE_TRANSCRIPT_INDEX", filepath.Join(dir, "index.sqlite"))
	e.Set("SHUTTLE_DAEMON_URL", "http://127.0.0.1:1")
	run := func(args ...string) (string, error) {
		out, _, err := executeIn(t, e, store, args...)
		return out, err
	}
	if out, err := run("transcript", "index"); err != nil {
		t.Fatalf("index: %v\n%s", err, out)
	}
	return run
}

func TestFindPointsAtTheMainThreadAndShowOpensIt(t *testing.T) {
	run := showFixture(t)

	// The subagent's brief matches more densely, but the session is
	// represented by its conversation.
	out, err := run("find", "fish", "recipe")
	if err != nil {
		t.Fatalf("find: %v\n%s", err, out)
	}
	if !strings.Contains(out, "2026-10-25  Bar rôti for dinner  · kitchen") || !strings.Contains(out, "→ shuttle show abcdef01:6\n") {
		t.Fatalf("want the titled session and its main-thread address:\n%s", out)
	}

	out, err = run("show", "abcdef01:7", "--around", "1")
	if err != nil {
		t.Fatalf("show: %v\n%s", err, out)
	}
	for _, want := range []string{
		"abcdef01:7 · ", "Bar rôti for dinner",
		"▶    7  assistant: The fish recipe: slash, salt, roast whole at 220°C.",
		"     6  user: Write down the fish recipe.",
		"     8  user: And a side?",
		"… earlier: shuttle show abcdef01:",
		"… later: shuttle show abcdef01:9",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("show is missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "Charred leeks") {
		t.Errorf("--around 1 reached two turns ahead:\n%s", out)
	}

	out, err = run("show", "abcdef01:4", "--around", "1")
	if err != nil {
		t.Fatalf("show: %v\n%s", err, out)
	}
	if !strings.Contains(out, "     2  ⚙ Read ×2") {
		t.Errorf("tool calls between turns should fold to one line:\n%s", out)
	}
}

func TestShowOutlinesASessionAndOpensSubagents(t *testing.T) {
	run := showFixture(t)

	out, err := run("show", "abcdef01")
	if err != nil {
		t.Fatalf("show outline: %v\n%s", err, out)
	}
	for _, want := range []string{"     1  user: What should we cook tonight?", "     6  user: Write down the fish recipe.", "     9  assistant: Charred leeks.", "open a turn: shuttle show abcdef01:<line>"} {
		if !strings.Contains(out, want) {
			t.Errorf("outline is missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "Base directory") {
		t.Errorf("outline kept a harness-injected turn:\n%s", out)
	}

	out, err = run("show", "abcdef01/9f8e7d6c:1", "--json")
	if err != nil {
		t.Fatalf("show subagent: %v\n%s", err, out)
	}
	var view transcriptView
	if err := json.Unmarshal([]byte(out), &view); err != nil {
		t.Fatalf("decode: %v\n%s", err, out)
	}
	if view.Subagent != "Check the recipe" || view.Title != "Bar rôti for dinner" || len(view.Messages) != 1 || !view.Messages[0].Hit {
		t.Fatalf("subagent view: %s", out)
	}

	if _, err := run("show", "abcdef01/00000000:1"); err == nil || !strings.Contains(err.Error(), "no subagent") {
		t.Fatalf("unknown subagent: %v", err)
	}
}
