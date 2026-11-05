package shuttle

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestChangeCaptureTypeChangesWithBigFileThreshold(t *testing.T) {
	env := testEnv(t)
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	env.Set("PATH", filepath.Dir(gitPath))
	env.Set("GIT_CONFIG_NOSYSTEM", "1")
	config := filepath.Join(t.TempDir(), "gitconfig")
	if err := os.WriteFile(config, []byte("[core]\n\tbigFileThreshold = 1k\n"), 0600); err != nil {
		t.Fatal(err)
	}
	env.Set("GIT_CONFIG_GLOBAL", config)
	repo := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		out, err := env.Command("git", append([]string{"-C", repo}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %s: %v", args, out, err)
		}
	}
	put := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(repo, name), []byte(body), 0644); err != nil {
			t.Fatal(err)
		}
	}
	git("init", "-q")
	git("config", "user.name", "Fixture")
	git("config", "user.email", "fixture@example.invalid")
	// Both exceed the operator's threshold; only the NUL-containing file is binary.
	bodies := map[string]string{"text": strings.Repeat("text line\n", 300), "binary": "\x00" + strings.Repeat("binary bytes", 300)}
	for name, body := range bodies {
		put(name, body)
	}
	git("add", ".")
	git("commit", "-qm", "Files")
	for name := range bodies {
		path := filepath.Join(repo, name)
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink("destination", path); err != nil {
			t.Fatal(err)
		}
	}
	git("add", ".")
	git("commit", "-qm", "Symlinks")
	check := func(reverse bool) {
		t.Helper()
		c, hunks, err := BuildChange(env, repo, "HEAD~", "HEAD", nil)
		if err != nil {
			t.Fatal(err)
		}
		if len(c.Files) != 2 {
			t.Fatalf("files: %+v", c.Files)
		}
		for _, f := range c.Files {
			add, del, count := 1, 300, 2
			if f.Path == "binary" {
				del, count = 0, 1
				if !strings.Contains(f.Header, "Binary files ") {
					t.Fatalf("missing binary section: %s", f.Header)
				}
			}
			if reverse {
				add, del = del, add
			}
			if f.Additions != add || f.Deletions != del || len(f.Hunks) != count || strings.Count(f.Header, "diff --git ") != 2 {
				t.Fatalf("type change lost a side: %+v", f)
			}
		}
		if report := ValidateChange(c, hunks); report.Total != 302 {
			t.Fatalf("coverage: %+v", report)
		}
	}
	check(false)
	for name, body := range bodies {
		if err := os.Remove(filepath.Join(repo, name)); err != nil {
			t.Fatal(err)
		}
		put(name, body)
	}
	git("add", ".")
	git("commit", "-qm", "Files again")
	check(true)
}
