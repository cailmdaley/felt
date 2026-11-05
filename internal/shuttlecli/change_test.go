package shuttlecli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/shuttle"
)

func TestChangeCommandRealGit(t *testing.T) {
	t.Parallel()
	dir, st := newStore(t)
	env := testEnv(t)
	env.Set("GIT_CONFIG_NOSYSTEM", "1")
	env.Set("GIT_CONFIG_GLOBAL", os.DevNull)
	env.Set("SHUTTLE_HOST", "change-host")
	events := filepath.Join(t.TempDir(), "events.jsonl")
	env.Set("SHUTTLE_EVENTS_FILE", events)
	repo := t.TempDir()
	env.Chdir(repo)
	git := func(args ...string) string {
		t.Helper()
		out, err := env.Command("git", append([]string{"-C", repo}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %s: %v", args, out, err)
		}
		return strings.TrimSpace(string(out))
	}
	put := func(path, text string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(text), 0644); err != nil {
			t.Fatal(err)
		}
	}
	git("init", "-b", "main")
	git("config", "user.name", "Change Author")
	git("config", "user.email", "author@example.invalid")
	put(filepath.Join(repo, "main.go"), "before\n")
	git("add", ".")
	git("commit", "-m", "base")
	base := git("rev-parse", "HEAD")
	git("checkout", "-b", "topic/change")
	put(filepath.Join(repo, "main.go"), "after\n")
	git("commit", "-am", "head subject")
	seedFiber(t, st, "review", "", "open", map[string]any{"project_dir": repo, "host": "change-host"}, nil)
	seedPlainFiber(t, st, "plain", "open")
	run := func(args ...string) (string, error) {
		t.Helper()
		out, _, err := executeIn(t, env, dir, append([]string{"change"}, args...)...)
		return out, err
	}
	bundlePath := filepath.Join(filepath.Dir(st.Path("review")), "topic-change.change.json")
	out, err := run("review", "--base", base)
	if err != nil {
		t.Fatalf("write: %v", err)
	}
	if !strings.Contains(out, "Hunks covered: 0 of 1") || !strings.Contains(out, "Remaining: main.go:1") || !strings.Contains(out, bundlePath) {
		t.Fatalf("stdout: %s", out)
	}
	original, err := os.ReadFile(bundlePath)
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := os.ReadFile(events)
	if err != nil {
		t.Fatal(err)
	}
	var delivered struct {
		Type      string   `json:"type"`
		SessionID string   `json:"sessionId"`
		Tmux      string   `json:"tmuxSession"`
		Files     []string `json:"files"`
	}
	if err := json.Unmarshal(receipt, &delivered); err != nil {
		t.Fatal(err)
	}
	fiber, _ := st.Read("review")
	expectedReceiptPath, _ := filepath.EvalSymlinks(bundlePath)
	if delivered.Type != "file_sent" || delivered.SessionID != fiber.UID || delivered.Tmux != "" || len(delivered.Files) != 1 || delivered.Files[0] != expectedReceiptPath {
		t.Fatalf("receipt: %+v", delivered)
	}
	var c shuttle.Change
	if err := json.Unmarshal(original, &c); err != nil {
		t.Fatal(err)
	}
	if c.Story != nil || c.Repo.Dir != repo || c.HeadRef != "topic/change" || c.Base != base {
		t.Fatalf("bundle: %+v", c)
	}
	storyPath := filepath.Join(t.TempDir(), "story.json")
	put(storyPath, `{"title":"A reading order","overview":"Overview","flags":[{"file":"main.go","from":1,"to":1,"text":"Look here"}],"chapters":[{"id":"change","title":"Change","narrative":"Read it","why_here":"Start here","stops":[{"file":"main.go","from":1,"to":1,"importance":"critical","note":"Reason"}]}],"roles":{"main.go":"generated"}}`)
	out, err = run("review", "--base", base, "--story", storyPath, "--check", "--name", "not-written", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var report shuttle.ChangeReport
	if err := json.Unmarshal([]byte(out), &report); err != nil {
		t.Fatalf("JSON report: %s: %v", out, err)
	}
	if !report.Valid || report.Covered != 1 || report.Total != 1 || len(report.Uncovered) != 0 || report.Path != "" {
		t.Fatalf("report: %+v", report)
	}
	notWritten := filepath.Join(filepath.Dir(bundlePath), "not-written.change.json")
	if _, err := os.Stat(notWritten); !os.IsNotExist(err) {
		t.Fatalf("--check wrote a companion: %v", err)
	}
	out, err = run("review", "--base", base, "--story", storyPath, "--json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(out), &report); err != nil {
		t.Fatal(err)
	}
	realBundlePath, err := filepath.EvalSymlinks(bundlePath)
	if err != nil {
		t.Fatal(err)
	}
	if report.Path != realBundlePath {
		t.Fatalf("output path: %+v", report)
	}
	withStory, err := os.ReadFile(bundlePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(withStory, &c); err != nil {
		t.Fatal(err)
	}
	if c.Title != "A reading order" || c.Story == nil || c.Files[0].Role != "generated" || c.Story.Chapters[0].Stops[0].From != 1 {
		t.Fatalf("story bundle: %+v", c)
	}
	entries, err := os.ReadDir(filepath.Dir(bundlePath))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".tmp") {
			t.Errorf("atomic write left temp file: %s", entry.Name())
		}
	}
	// Invalid references are all returned, and cannot overwrite the valid bundle.
	put(storyPath, `{"flags":[{"file":"unknown.go"},{"file":"main.go","from":90,"to":91}],"chapters":[{"stops":[{"file":"also-missing","importance":"context"}]}]}`)
	out, err = run("review", "--base", base, "--story", storyPath, "--json")
	if err == nil || !strings.Contains(err.Error(), "flags[0]") || !strings.Contains(err.Error(), "flags[1]") || !strings.Contains(err.Error(), "chapters[0].stops[0]") {
		t.Fatalf("validation error: %v", err)
	}
	if err := json.Unmarshal([]byte(out), &report); err != nil {
		t.Fatal(err)
	}
	if report.Valid || len(report.Errors) != 3 || report.Covered != 0 || len(report.Uncovered) != 1 {
		t.Fatalf("invalid report: %+v", report)
	}
	unchanged, err := os.ReadFile(bundlePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(unchanged) != string(withStory) {
		t.Fatal("validation failure overwrote the bundle")
	}
	out, err = run("review", "--base", base, "--check", "--json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(out), &report); err != nil {
		t.Fatal(err)
	}
	if !report.Valid || report.Total != 1 || report.Covered != 0 {
		t.Fatalf("storyless check: %+v", report)
	}
	// Explicit repo overrides project_dir; a plain fiber falls back to cwd.
	seedFiber(t, st, "wrong-dir", "", "open", map[string]any{"project_dir": filepath.Join(repo, "missing")}, nil)
	if _, err := run("wrong-dir", "--base", base, "--repo", repo, "--check"); err != nil {
		t.Fatal(err)
	}
	if _, err := run("plain", "--base", base, "--name", "custom"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(st.Path("plain")), "custom.change.json")); err != nil {
		t.Fatal(err)
	}
	git("checkout", "--detach", "HEAD")
	if _, err := run("plain", "--base", base); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(st.Path("plain")), "plain.change.json")); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		args []string
		want string
	}{
		{"required base", []string{"plain"}, "base"},
		{"unknown base", []string{"plain", "--base", "absent"}, "absent"},
		{"unknown head", []string{"plain", "--base", base, "--head", "absent"}, "absent"},
		{"name traversal", []string{"plain", "--base", base, "--name", "../escape"}, "filename stem"},
		{"non-repo", []string{"plain", "--base", base, "--repo", t.TempDir()}, "git"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := run(tc.args...); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error: %v, want %q", err, tc.want)
			}
		})
	}
	for _, text := range []string{`{`, `null`, `[]`, `{"chapters":"bad"}`, `{"overveiw":"typo"}`, `{"chapters":[{"id":"same"},{"id":"same"}]}`, `{"title":"Review\nHead: forged"}`, `{"title":"bad\u007f"}`, `{"chapters":[{"stops":[{"file":"main.go","importance":"critical","form":1}]}]}`, `{} {}`} {
		put(storyPath, text)
		if _, err := run("plain", "--base", base, "--story", storyPath); err == nil {
			t.Fatalf("accepted malformed story %q", text)
		}
	}
	seedFiber(t, st, "remote", "", "open", map[string]any{"project_dir": repo, "host": "other-host"}, nil)
	if _, err := run("remote", "--base", base); err == nil || !strings.Contains(err.Error(), "other-host") {
		t.Fatalf("remote owner: %v", err)
	}
}
