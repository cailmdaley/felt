package shuttle

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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
	put("binary", "\x00"+strings.Repeat("unchanged binary data\n", 100)+"old\n")
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
	if err := os.Chmod(filepath.Join(repo, "sp ace"), 0755); err != nil {
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
		want, newMode := 1, "100644"
		if f.Path == "subdir/type" {
			want, newMode = 2, "120000"
		}
		if f.Path == "sp ace" {
			newMode = "100755"
		}
		if f.OldPath != "" || f.OldMode != "100644" || f.NewMode != newMode {
			t.Errorf("file metadata: %+v", f)
		}
		if seen[f.Path] != want || f.Status != "modified" {
			t.Errorf("file %+v has %d hunks, want %d", f, seen[f.Path], want)
		}
	}
	// A renamed text file's hunk uses the destination path, including spaces.
	git("mv", "sp ace", "renamed space")
	put("renamed space", "-- after\n++ after\nextra\n")
	git("mv", "binary", "z renamed binary")
	put("z renamed binary", "\x00"+strings.Repeat("unchanged binary data\n", 100)+"new\n")
	git("add", ".")
	git("commit", "-m", "rename with edit")
	c, hunks, err = BuildChange(env, repo, "HEAD~", "HEAD", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Files) != 2 || c.Files[0].Path != "renamed space" || c.Files[0].OldPath != "sp ace" || c.Files[0].OldMode != "100755" || c.Files[0].NewMode != "100755" || c.Files[0].Status != "renamed" || len(hunks) != 1 || hunks[0].File != "renamed space" {
		t.Fatalf("rename: %+v, hunks %+v", c.Files, hunks)
	}
	binary := c.Files[1]
	if binary.Path != "z renamed binary" || binary.OldPath != "binary" || binary.Status != "renamed" || len(binary.Hunks) != 0 || !strings.Contains(binary.Header, "Binary files ") || strings.Contains(binary.Header, "--- ") || strings.Contains(binary.Header, "+++ ") {
		t.Fatalf("binary rename: %+v", binary)
	}
}
