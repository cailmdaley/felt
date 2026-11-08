package shuttlecli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// findFixture is a store holding one fiber about "bar roti" and a Claude
// transcript that discussed the "fish recipe", indexed.
func findFixture(t *testing.T) func(args ...string) (string, error) {
	t.Helper()
	e := testEnv(t)
	dir := t.TempDir()
	store := filepath.Join(dir, "store")
	fiber := filepath.Join(store, ".felt", "kitchen", "bar-roti")
	if err := os.MkdirAll(fiber, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fiber, "bar-roti.md"), []byte("---\nname: Bar rôti\noutcome: Whole roast sea bass, the fish recipe from the market.\n---\n\nSlash, salt, roast.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	projects := filepath.Join(dir, "claude-projects", "-work")
	if err := os.MkdirAll(projects, 0o755); err != nil {
		t.Fatal(err)
	}
	const session = "11111111-2222-4333-8444-555555555555"
	line := `{"type":"assistant","sessionId":"` + session + `","cwd":"/work","timestamp":"2026-10-25T10:00:00Z","message":{"role":"assistant","content":"Here is the fish recipe: roast it whole."}}` + "\n"
	if err := os.WriteFile(filepath.Join(projects, session+".jsonl"), []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	e.Set("SHUTTLE_CLAUDE_PROJECTS_DIR", filepath.Join(dir, "claude-projects"))
	e.Set("SHUTTLE_CODEX_SESSIONS_DIR", filepath.Join(dir, "codex"))
	e.Set("SHUTTLE_PI_SESSIONS_DIR", filepath.Join(dir, "pi"))
	e.Set("SHUTTLE_TRANSCRIPT_INDEX", filepath.Join(dir, "index.sqlite"))
	run := func(args ...string) (string, error) {
		out, _, err := executeIn(t, e, store, args...)
		return out, err
	}
	if out, err := run("transcript", "index"); err != nil {
		t.Fatalf("index: %v\n%s", err, out)
	}
	return run
}

func TestFindReturnsFibersThenSessions(t *testing.T) {
	run := findFixture(t)

	out, err := run("find", "fish", "recipe")
	if err != nil {
		t.Fatalf("find: %v\n%s", err, out)
	}
	fiberAt, sessionsAt := strings.Index(out, "kitchen/bar-roti"), strings.Index(out, "── sessions ──")
	if fiberAt < 0 || sessionsAt < fiberAt || !strings.Contains(out[sessionsAt:], "11111111") {
		t.Fatalf("want the fiber, then the session:\n%s", out)
	}

	out, err = run("find", "fish recipe", "--json")
	if err != nil {
		t.Fatalf("find --json: %v\n%s", err, out)
	}
	var got struct {
		Fibers []struct {
			ID    string `json:"id"`
			Store string `json:"store"`
		} `json:"fibers"`
		Transcripts []struct {
			Session string `json:"session"`
		} `json:"transcripts"`
		Errors []string `json:"errors"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("decode: %v\n%s", err, out)
	}
	if len(got.Fibers) != 1 || got.Fibers[0].ID != "kitchen/bar-roti" || len(got.Transcripts) != 1 || got.Transcripts[0].Session != "11111111-2222-4333-8444-555555555555" {
		t.Fatalf("unexpected result: %s", out)
	}
}

func TestFindKeepsOneHalfWhenTheOtherFails(t *testing.T) {
	run := findFixture(t)

	// A regex is a fiber-only search: sessions are skipped, not failed.
	out, err := run("find", "-r", "sea ba+ss")
	if err != nil || !strings.Contains(out, "kitchen/bar-roti") || strings.Contains(out, "sessions") {
		t.Fatalf("regex find: %v\n%s", err, out)
	}

	// No store: the sessions still answer, with the fiber failure reported.
	out, err = run("-C", t.TempDir(), "find", "fish", "--json")
	if err != nil {
		t.Fatalf("storeless find: %v\n%s", err, out)
	}
	if !strings.Contains(out, `"session": "11111111`) || !strings.Contains(out, "fibers: not in a felt repository") {
		t.Fatalf("storeless find: %s", out)
	}
}
