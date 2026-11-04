package shuttle

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestBuildChangePathsAndFileTypes(t *testing.T) {
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
	git := func(args ...string) {
		t.Helper()
		out, err := env.Command("git", append([]string{"-C", repo}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %s: %v", args, out, err)
		}
	}
	put := func(path, text string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(repo, path), []byte(text), 0644); err != nil {
			t.Fatal(err)
		}
	}
	git("init", "-b", "main")
	git("config", "user.name", "Change Author")
	git("config", "user.email", "author@example.invalid")
	if err := os.Mkdir(filepath.Join(repo, "subdir"), 0755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"sp ace", "tab\tpath", "line\npath", "unicodé", "subdir/type"} {
		put(name, "-- before\n++ before\n")
	}
	git("add", ".")
	git("commit", "-m", "base")
	for _, name := range []string{"sp ace", "tab\tpath", "line\npath", "unicodé"} {
		put(name, "-- after\n++ after\n")
	}
	if err := os.Remove(filepath.Join(repo, "subdir/type")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("destination", filepath.Join(repo, "subdir/type")); err != nil {
		t.Fatal(err)
	}
	git("add", ".")
	git("commit", "-m", "head")
	// The caller's diff formatting and relative-path settings must not change the schema.
	git("config", "diff.relative", "true")
	git("config", "diff.noprefix", "true")
	git("config", "core.quotePath", "false")
	c, hunks, err := BuildChange(env, filepath.Join(repo, "subdir"), "HEAD~", "HEAD", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Files) != 5 || len(hunks) != 6 {
		t.Fatalf("files: %+v, hunks: %+v\n%s", c.Files, hunks, c.Patch)
	}
	seen := map[string]int{}
	for _, h := range hunks {
		seen[h.File]++
	}
	for _, f := range c.Files {
		want := 1
		if f.Path == "subdir/type" {
			want = 2
		}
		if seen[f.Path] != want || f.Status != "modified" {
			t.Errorf("file %+v has %d hunks, want %d", f, seen[f.Path], want)
		}
	}
	// A renamed text file's hunk uses the destination path, including spaces.
	git("mv", "sp ace", "renamed space")
	put("renamed space", "-- after\n++ after\nextra\n")
	git("add", ".")
	git("commit", "-m", "rename with edit")
	c, hunks, err = BuildChange(env, repo, "HEAD~", "HEAD", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Files) != 1 || c.Files[0].Path != "renamed space" || c.Files[0].Status != "renamed" || len(hunks) != 1 || hunks[0].File != "renamed space" {
		t.Fatalf("rename: %+v, hunks %+v", c.Files, hunks)
	}
}
