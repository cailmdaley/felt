package shuttle

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestChangeLineCoverageRealGit(t *testing.T) {
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
	put := func(name, text string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(repo, name), []byte(text), 0644); err != nil {
			t.Fatal(err)
		}
	}
	git("init", "-b", "main")
	git("config", "user.name", "Fixture Author")
	git("config", "user.email", "fixture@example.invalid")
	for _, name := range []string{"space name.go", "é.go", "cr.go", "type.go", "gone.go", "rename.go", "app_test.go"} {
		put(name, "before\r\n"+strings.Repeat(name+"\n", 20)+"end\n")
	}
	git("add", ".")
	git("commit", "-qm", "Base")
	for _, name := range []string{"space name.go", "é.go", "cr.go", "app_test.go"} {
		put(name, "after\r\n"+strings.Repeat(name+"\n", 20)+"tail\n")
	}
	if err := os.Remove(filepath.Join(repo, "type.go")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("target", filepath.Join(repo, "type.go")); err != nil {
		t.Fatal(err)
	}
	git("rm", "gone.go")
	git("mv", "rename.go", "renamed space.go")
	put("renamed space.go", "changed\r\n"+strings.Repeat("rename.go\n", 20)+"end\n")
	put("added.go", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n")
	git("add", ".")
	git("commit", "-qm", "Head")
	c, hunks, err := BuildChange(env, repo, "HEAD~", "HEAD", nil)
	if err != nil {
		t.Fatal(err)
	}
	stop := func(file string, from, to int, side string) ChangeStop {
		return ChangeStop{ChangeRange: ChangeRange{File: file, From: from, To: to, Side: side}, Importance: "important"}
	}
	c.Story = &ChangeStory{Chapters: []ChangeChapter{
		{ID: "first", Stops: []ChangeStop{stop("added.go", 1, 2, "new"), stop("space name.go", 1, 1, "old"), stop("cr.go", 2, 3, "new"), stop("type.go", 1, 1, "new")}},
		{ID: "second", Stops: []ChangeStop{stop("added.go", 3, 4, "new"), stop("added.go", 2, 3, "new"), stop("space name.go", 1, 1, "new"), stop("gone.go", 1, 3, "old"), stop("renamed space.go", 1, 1, "new")}},
	}}
	report := ValidateChange(c, hunks)
	if !report.Valid {
		t.Fatal(report.Errors)
	}
	type key struct {
		file, side string
		line       int
		text       string
	}
	keys := func(file string, hs []ChangeHunk) map[key]bool {
		found := map[key]bool{}
		for _, h := range hs {
			for _, row := range h.rows {
				side, line := "new", row.new
				if row.text[0] == '-' {
					side, line = "old", row.old
				} else if row.text[0] != '+' {
					continue
				}
				found[key{file, side, line, row.text}] = true
			}
		}
		return found
	}
	original, shown, actualRemaining, rendered := map[key]bool{}, map[key]bool{}, map[key]bool{}, map[key]bool{}
	for _, f := range c.Files {
		for k := range keys(f.Path, f.Hunks) {
			original[k] = true
		}
		for _, h := range f.Hunks {
			for _, row := range h.rows {
				for _, chapter := range c.Story.Chapters {
					for _, s := range chapter.Stops {
						if s.File == f.Path && s.includes(row) {
							for k := range keys(f.Path, []ChangeHunk{{rows: []changeRow{row}}}) {
								shown[k] = true
							}
						}
					}
				}
			}
		}
		for k := range keys(f.Path, f.Remaining) {
			actualRemaining[k] = true
		}
		// Every independently rendered window must preserve the exact side, coordinates and bytes.
		for _, h := range append(append([]ChangeHunk{}, f.Hunks...), f.Remaining...) {
			got := map[key]bool{}
			for _, w := range h.Windows {
				parsed := &Change{Files: []ChangeFile{{Path: f.Path}}, Patch: w.Patch}
				wh, err := parsed.parsePatch()
				if err != nil {
					t.Fatal(err)
				}
				for k := range keys(f.Path, wh) {
					got[k] = true
				}
			}
			if !reflect.DeepEqual(got, keys(f.Path, []ChangeHunk{h})) {
				t.Fatalf("window lost or moved rows in %s: %s", f.Path, h.Patch)
			}
		}
		lane := f.Remaining
		if f.Role == "test" {
			lane = f.Hunks
		}
		for k := range keys(f.Path, lane) {
			rendered[k] = true
		}
	}
	for _, chapter := range c.Story.Chapters {
		for _, s := range chapter.Stops {
			for k := range keys(s.File, s.Hunks) {
				rendered[k] = true
			}
		}
	}
	expectedRemaining := map[key]bool{}
	for k := range original {
		if !shown[k] {
			expectedRemaining[k] = true
		}
	}
	if !reflect.DeepEqual(expectedRemaining, actualRemaining) {
		t.Fatalf("Remaining differs from unshown changed lines: want %v, got %v", expectedRemaining, actualRemaining)
	}
	if !reflect.DeepEqual(original, rendered) {
		t.Fatalf("a changed row vanished or was invented: want %v, got %v", original, rendered)
	}
	if report.Covered != 11 || report.Covered != len(shown) || report.Total != len(original) {
		t.Fatalf("line report: %+v, shown %d, total %d", report, len(shown), len(original))
	}
	if !shown[key{"added.go", "new", 4, "+four"}] || shown[key{"added.go", "new", 5, "+five"}] {
		t.Fatal("unions did not cover exactly lines 1..4")
	}
	for _, f := range c.Files {
		if f.Path == "added.go" {
			if len(f.Remaining) != 1 || f.Remaining[0].NewFrom != 5 || f.Remaining[0].NewLines != 5 {
				t.Fatal(fmt.Sprintf("added remainder: %+v", f.Remaining))
			}
		}
	}
}
