package shuttlecli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
)

func TestChangeCommandBakesTheNamedChangeIntoTheCache(t *testing.T) {
	t.Parallel()
	dir, st := newStore(t)
	env := testEnv(t)
	env.Set("GIT_CONFIG_NOSYSTEM", "1")
	env.Set("GIT_CONFIG_GLOBAL", os.DevNull)
	env.Set("SHUTTLE_HOST", "change-host")
	events := filepath.Join(t.TempDir(), "events.jsonl")
	env.Set("SHUTTLE_EVENTS_FILE", events)
	repo := t.TempDir()
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
	git("update-ref", "refs/remotes/origin/main", "HEAD")
	git("checkout", "-b", "topic")
	put(filepath.Join(repo, "main.go"), "after\n")
	git("commit", "-am", "Topic subject", "-m", "Why the topic exists.")
	put(filepath.Join(repo, "main.go"), "after, and edited\n")
	seedFiber(t, st, "named", "", "open", map[string]any{"project_dir": repo, "host": "change-host"}, nil)
	fiber, _ := st.Read("named")
	fiberDir := filepath.Dir(st.Path("named"))
	cacheDir, err := env.CacheDir()
	if err != nil {
		t.Fatal(err)
	}
	bake := func(id string, args ...string) (shuttle.ChangeReport, shuttle.Change) {
		t.Helper()
		out, _, err := executeIn(t, env, dir, append([]string{"change", id, "--cache", "--json"}, args...)...)
		if err != nil {
			t.Fatalf("bake %s: %v\n%s", id, err, out)
		}
		var report shuttle.ChangeReport
		if err := json.Unmarshal([]byte(out), &report); err != nil {
			t.Fatalf("report: %s: %v", out, err)
		}
		data, err := os.ReadFile(report.Path)
		if err != nil {
			t.Fatal(err)
		}
		var c shuttle.Change
		if err := json.Unmarshal(data, &c); err != nil {
			t.Fatal(err)
		}
		return report, c
	}
	besideFiber := func() string {
		t.Helper()
		entries, err := os.ReadDir(fiberDir)
		if err != nil {
			t.Fatal(err)
		}
		var names []string
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		return strings.Join(names, " ")
	}
	before := besideFiber()

	report, c := bake("named")
	if report.Path != filepath.Join(cacheDir, "felt", "changes", fiber.UID, "topic.change.json") || report.Title != "Topic subject" {
		t.Fatalf("report: %+v", report)
	}
	if c.BaseRef != "origin/main" || c.HeadRef != "topic" || len(c.Commits) != 2 || c.Stats.Additions != 1 {
		t.Fatalf("branch view: %+v", c)
	}
	if c.Description != "**Topic subject**\n\nWhy the topic exists.\n\n**Uncommitted changes**" {
		t.Fatalf("description: %q", c.Description)
	}
	if after := besideFiber(); after != before {
		t.Fatalf("cache bake wrote beside the fiber: %v, was %v", after, before)
	}
	if _, err := os.Stat(events); !os.IsNotExist(err) {
		t.Fatalf("cache bake emitted a delivery receipt: %v", err)
	}

	// An authored story beside the fiber is read, never rewritten.
	story := `{"overview":"Read main.go","chapters":[]}`
	put(filepath.Join(fiberDir, "topic.story.json"), story)
	if _, c = bake("named"); c.Story == nil || c.Story.Overview != "Read main.go" {
		t.Fatalf("story: %+v", c.Story)
	}
	if data, _ := os.ReadFile(filepath.Join(fiberDir, "topic.story.json")); string(data) != story {
		t.Fatalf("sidecar rewritten: %s", data)
	}

	// No uncommitted work: the head is HEAD itself.
	git("commit", "-am", "Edit committed")
	if _, c = bake("named"); c.Head != git("rev-parse", "HEAD") || c.Commits[1].Subject != "Edit committed" {
		t.Fatalf("committed head: %+v", c)
	}

	// shuttle.change names the base, and its PRs replace the branch view.
	seedFiber(t, st, "based", "", "open", map[string]any{"project_dir": repo, "host": "change-host", "change": map[string]any{"base": "main"}}, nil)
	if _, c = bake("based"); c.BaseRef != "main" {
		t.Fatalf("named base: %+v", c)
	}
	git("remote", "add", "origin", repo)
	git("config", "url."+repo+".insteadOf", "https://example.invalid/base/repo")
	sysenvtest.FakeCommand(t, env, "gh", fmt.Sprintf(`printf '%%s' '{"number":7,"title":"A first-class PR","body":"The PR says why.","url":"https://example.invalid/base/repo/pull/7","headRefName":"topic","headRefOid":"%s","baseRefName":"main","state":"OPEN","statusCheckRollup":[]}'`, git("rev-parse", "HEAD")))
	seedFiber(t, st, "followed", "", "open", map[string]any{"project_dir": repo, "host": "change-host", "change": map[string]any{"prs": []int{7, 9}}}, nil)
	report, c = bake("followed")
	if filepath.Base(report.Path) != "pr-7.change.json" || c.PR == nil || c.PR.Number != 7 || c.Description != "The PR says why." {
		t.Fatalf("PR bake: %+v %+v", report, c)
	}
}
