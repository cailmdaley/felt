package shuttle

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestChangeCaptureIgnoresDiffConfigAndWorktreeAttributes(t *testing.T) {
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
	put := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(repo, name), []byte(body), 0644); err != nil {
			t.Fatal(err)
		}
	}
	git("init", "-q")
	git("config", "user.name", "Fixture")
	git("config", "user.email", "fixture@example.invalid")
	put("app.go", "old\n\n"+strings.Repeat("context\n", 20)+"tail\n")
	put("marked.go", "old text\n")
	put("binary.bin", "\x00old")
	put(".gitattributes", "marked.go -diff\n")
	git("add", ".")
	git("commit", "-qm", "Base")
	base := git("rev-parse", "HEAD")
	put("app.go", "new\n\n"+strings.Repeat("context\n", 20)+"end\n")
	put("marked.go", "new text\n")
	put("binary.bin", "\x00new")
	git("add", ".")
	git("commit", "-qm", "Head")
	before, bh, err := BuildChange(env, repo, base, "HEAD", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(before.Patch, "+new text") || !strings.Contains(before.Patch, "Binary files a/binary.bin") {
		t.Fatal(before.Patch)
	}
	for _, tc := range []struct{ from, to, covered, partial int }{{2, 2, 0, 1}, {1, 1, 1, 0}, {1, 3, 1, 0}} {
		before.Story = &ChangeStory{Chapters: []ChangeChapter{{ID: "read", Stops: []ChangeStop{{ChangeRange: ChangeRange{File: "app.go", From: tc.from, To: tc.to}, Importance: "important"}}}}}
		report := ValidateChange(before, bh)
		if !report.Valid || report.Covered != tc.covered || len(report.Partial) != tc.partial {
			t.Fatalf("coverage %+v: %+v", tc, report)
		}
		stop := before.Story.Chapters[0].Stops[0]
		if len(stop.Hunks) != 1 || !strings.Contains(stop.Hunks[0].Patch, "@@") {
			t.Fatalf("missing resolved excerpt: %+v", stop)
		}
	}
	before.Story = nil
	ValidateChange(before, bh)
	for key, value := range map[string]string{"diff.suppressBlankEmpty": "true", "diff.abbrev": "1", "diff.noprefix": "true", "diff.mnemonicPrefix": "true", "diff.renames": "false", "diff.context": "0", "diff.interHunkContext": "100", "diff.algorithm": "histogram", "diff.external": "/nonexistent", "core.attributesFile": filepath.Join(repo, "global-attrs")} {
		git("config", key, value)
	}
	put(".gitattributes", "* -diff\n")
	put("global-attrs", "* -diff\n")
	put(".git/info/attributes", "* -diff\n")
	after, ah, err := BuildChange(env, repo, base, "HEAD", nil)
	if err != nil {
		t.Fatal(err)
	}
	if before.Patch != after.Patch || !reflect.DeepEqual(bh, ah) || !reflect.DeepEqual(before.Files, after.Files) {
		t.Fatalf("capture changed under config or dirty attributes:\n%s", after.Patch)
	}
}
