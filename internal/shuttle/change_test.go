package shuttle

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestBuildChangeRealGit(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	env.Set("PATH", filepath.Dir(gitPath))
	env.Set("GIT_CONFIG_NOSYSTEM", "1")
	env.Set("GIT_CONFIG_GLOBAL", os.DevNull)
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
		full := filepath.Join(repo, path)
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(text), 0644); err != nil {
			t.Fatal(err)
		}
	}
	git("init", "-b", "main")
	git("config", "user.name", "Change Author")
	git("config", "user.email", "author@example.invalid")
	put("modified.go", strings.Repeat("unchanged\n", 30))
	put("deleted.go", "gone\n")
	put("old name\t.go", "rename me\n")
	put("image.bin", "\x00old\x00")
	put("line\nbreak.go", "before\n")
	put("deleted-on-main.go", "untouched on topic\n")
	git("add", ".")
	git("commit", "-m", "base")
	base := git("rev-parse", "HEAD")
	git("checkout", "-b", "topic/change")
	put("modified.go", "first\n"+strings.Repeat("unchanged\n", 28)+"last\n")
	put("tests/new_test.py", "assert True\n")
	if err := os.Remove(filepath.Join(repo, "deleted.go")); err != nil {
		t.Fatal(err)
	}
	git("mv", "old name\t.go", "new name\t.go")
	put("image.bin", "\x00new\x00")
	put("line\nbreak.go", "after\n")
	git("add", ".")
	git("commit", "-m", "head subject")
	head := git("rev-parse", "HEAD")
	// The snapshot must ignore dirty and untracked worktree content.
	put("modified.go", "dirty\n")
	put("untracked", "ignore\n")
	c, hunks, err := BuildChange(env, repo, base, "HEAD", nil)
	if err != nil {
		t.Fatal(err)
	}
	if c.Base != base || c.Head != head || c.HeadRef != "topic/change" || c.BaseRef != base || c.Title != "head subject" || c.Story != nil {
		t.Fatalf("metadata: %+v", c)
	}
	if c.Version != 1 || c.Repo.Dir != repo || c.Repo.Name != filepath.Base(repo) || c.Repo.ForgeURL != nil {
		t.Fatalf("repo: %+v", c.Repo)
	}
	if len(c.Commits) != 1 || c.Commits[0].SHA != head || c.Commits[0].Author != "Change Author" || c.Commits[0].Subject != "head subject" {
		t.Fatalf("commits: %+v", c.Commits)
	}
	if _, err := time.Parse(time.RFC3339, c.Commits[0].Time); err != nil {
		t.Fatal(err)
	}
	want := []ChangeFile{
		{Path: "deleted.go", OldMode: "100644", NewMode: "000000", Status: "deleted", Role: "implementation", Deletions: 1},
		{Path: "image.bin", OldMode: "100644", NewMode: "100644", Status: "modified", Role: "implementation"},
		{Path: "line\nbreak.go", OldMode: "100644", NewMode: "100644", Status: "modified", Role: "implementation", Additions: 1, Deletions: 1},
		{Path: "modified.go", OldMode: "100644", NewMode: "100644", Status: "modified", Role: "implementation", Additions: 2, Deletions: 2},
		{Path: "new name\t.go", OldPath: "old name\t.go", OldMode: "100644", NewMode: "100644", Status: "renamed", Role: "implementation"},
		{Path: "tests/new_test.py", OldMode: "000000", NewMode: "100644", Status: "added", Role: "test", Additions: 1},
	}
	metadata := append([]ChangeFile{}, c.Files...)
	for i := range metadata {
		metadata[i].Header = ""
		metadata[i].Hunks = nil
		metadata[i].Remaining = nil
	}
	if !reflect.DeepEqual(metadata, want) {
		t.Fatalf("files:\n%+v\nwant:\n%+v", c.Files, want)
	}
	if len(hunks) != 5 {
		t.Fatalf("hunks: %+v\n%s", hunks, c.Patch)
	}
	for _, fragment := range []string{"Binary files", "rename from", "rename to", "+first", "+last", "-gone", "+assert True"} {
		if !strings.Contains(c.Patch, fragment) {
			t.Errorf("patch missing %q", fragment)
		}
	}
	if strings.Contains(c.Patch, "dirty") || strings.Contains(c.Patch, "untracked") {
		t.Fatalf("dirty snapshot: %s", c.Patch)
	}
	report := ValidateChange(c, hunks)
	if !report.Valid || report.Total != 8 || report.Covered != 0 || len(report.Uncovered) != 5 {
		t.Fatalf("report: %+v", report)
	}
	minimal, _, err := BuildChange(env, repo, base, "HEAD", &ChangeStory{Overview: "Overview"})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(minimal)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"flags":[]`) || !strings.Contains(string(encoded), `"chapters":[]`) {
		t.Fatalf("story arrays: %s", encoded)
	}
	// Main-only additions and deletions must not appear reversed in the topic change.
	git("checkout", "--", "modified.go")
	git("checkout", "main")
	put("main-only.go", "main\n")
	git("rm", "deleted-on-main.go")
	git("add", ".")
	git("commit", "-m", "main advance")
	mergeBase := git("merge-base", "main", "topic/change")
	if mergeBase != base {
		t.Fatal("unexpected merge base")
	}
	merged, mergedHunks, err := BuildChange(env, repo, mergeBase, "topic/change", nil)
	if err != nil {
		t.Fatal(err)
	}
	ValidateChange(merged, mergedHunks)
	if merged.Base != base || merged.Head != head || merged.Patch != c.Patch || len(merged.Commits) != 1 {
		t.Fatalf("merge-base snapshot: %+v", merged)
	}
	direct, directHunks, err := BuildChange(env, repo, "main", "topic/change", nil)
	if err != nil {
		t.Fatal(err)
	}
	ValidateChange(direct, directHunks)
	if direct.Base != base || direct.BaseRef != "main" || direct.Patch != c.Patch || !reflect.DeepEqual(direct.Files, c.Files) || !reflect.DeepEqual(direct.Commits, c.Commits) || !reflect.DeepEqual(directHunks, hunks) {
		t.Fatalf("diverged base changed the topic snapshot: %+v", direct)
	}
	if strings.Contains(direct.Patch, "main-only.go") || strings.Contains(direct.Patch, "deleted-on-main.go") {
		t.Fatal("main-only changes leaked into topic patch")
	}
	if !reflect.DeepEqual(ValidateChange(direct, directHunks), report) {
		t.Fatal("coverage does not describe the merge-base diff")
	}
	changedByCommits := git("diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "-M", direct.Commits[0].SHA)
	for _, f := range direct.Files {
		if !strings.Contains("\x00"+changedByCommits, "\x00"+f.Path+"\x00") {
			t.Errorf("file %q is not in the topic commit", f.Path)
		}
	}
	git("checkout", "--detach", head)
	detached, _, err := BuildChange(env, repo, base, "HEAD", nil)
	if err != nil || detached.HeadRef != "HEAD" {
		t.Fatalf("detached: %+v, %v", detached, err)
	}
	if _, _, err := BuildChange(env, repo, "missing-ref", "HEAD", nil); err == nil || !strings.Contains(err.Error(), "missing-ref") {
		t.Fatalf("bad ref: %v", err)
	}
	empty, emptyHunks, err := BuildChange(env, repo, head, head, nil)
	if err != nil || len(empty.Files) != 0 || len(empty.Commits) != 0 || len(emptyHunks) != 0 || empty.Patch != "" {
		t.Fatalf("empty: %+v, %v", empty, err)
	}
	git("checkout", "--orphan", "unrelated")
	git("rm", "-rf", ".")
	git("commit", "--allow-empty", "-m", "unrelated root")
	if _, _, err := BuildChange(env, repo, "main", "unrelated", nil); err == nil || !strings.Contains(err.Error(), "no common ancestor") {
		t.Fatalf("unrelated history: %v", err)
	}
}

func TestValidateChange(t *testing.T) {
	t.Parallel()
	hunks := []ChangeHunk{
		{File: "main.go", OldFrom: 10, OldLines: 5, NewFrom: 10, NewLines: 6},
		{File: "main.go", OldFrom: 40, OldLines: 5, NewFrom: 41, NewLines: 6},
		{File: "gone.go", OldFrom: 1, OldLines: 3, NewFrom: 0, NewLines: 0},
		{File: "added.go", OldFrom: 0, OldLines: 0, NewFrom: 1, NewLines: 2},
	}
	for i := range hunks {
		h := &hunks[i]
		for n := 0; n < h.OldLines; n++ {
			h.rows = append(h.rows, changeRow{"-old", h.OldFrom + n, h.NewFrom})
		}
		for n := 0; n < h.NewLines; n++ {
			h.rows = append(h.rows, changeRow{"+new", h.OldFrom + h.OldLines, h.NewFrom + n})
		}
	}
	tests := []struct {
		name, story     string
		covered, errors int
		fragments       []string
	}{
		{name: "null", story: `null`},
		{name: "whole file", story: `{"chapters":[{"stops":[{"file":"main.go","importance":"important"}]}]}`, covered: 12},
		{name: "overlap and duplicate", story: `{"chapters":[{"stops":[{"file":"main.go","from":15,"to":30,"importance":"critical"},{"file":"main.go","from":10,"to":10,"importance":"context"}]}]}`, covered: 2},
		{name: "old deletion", story: `{"chapters":[{"stops":[{"file":"gone.go","from":1,"to":3,"side":"old","importance":"supporting"}]}]}`, covered: 3},
		{name: "flags not coverage", story: `{"flags":[{"file":"main.go","from":10,"to":10}]}`},
		{name: "metadata", story: `{"chapters":[{"stops":[{"file":"binary.bin","importance":"context"}]}],"roles":{"main.go":"generated"}}`},
		{name: "every bad reference", story: `{"flags":[{"file":"unknown.go"},{"file":"main.go","from":99,"to":101}],"chapters":[{"stops":[{"file":"also-unknown.go","importance":"context"},{"file":"gone.go","from":1,"to":2,"importance":"context"},{"file":"added.go","from":1,"to":2,"side":"old","importance":"context"}]}]}`, errors: 5, fragments: []string{"flags[0]", "flags[1]", "chapters[0].stops[0]", "chapters[0].stops[1]", "chapters[0].stops[2]", "unknown.go", "new side", "old side"}},
		{name: "bad shape", story: `{"flags":[{"file":"main.go","side":"both"},{"file":"main.go","from":10},{"file":"main.go","from":11,"to":10},{"file":"main.go","from":-1,"to":10}],"chapters":[{"stops":[{"file":"main.go","importance":"tiny"}]}],"roles":{"main.go":"other","unknown":"docs"}}`, covered: 12, errors: 7},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := &Change{Files: []ChangeFile{{Path: "main.go", Role: "implementation"}, {Path: "gone.go"}, {Path: "added.go"}, {Path: "binary.bin"}}}
			if err := json.Unmarshal([]byte(tt.story), &c.Story); err != nil {
				t.Fatal(err)
			}
			report := ValidateChange(c, hunks)
			if report.Covered != tt.covered || len(report.Errors) != tt.errors || report.Total != 27 || report.Valid != (tt.errors == 0) {
				t.Fatalf("report: %+v", report)
			}
			for _, fragment := range tt.fragments {
				if !strings.Contains(strings.Join(report.Errors, "\n"), fragment) {
					t.Errorf("missing %q in %+v", fragment, report.Errors)
				}
			}
			if tt.name == "metadata" && c.Files[0].Role != "generated" {
				t.Fatal("role override not applied")
			}
		})
	}
}
