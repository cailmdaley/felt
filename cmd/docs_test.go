package cmd

import (
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

var retiredCommandPhrases = []string{
	"felt tag ",
	"felt untag ",
	"felt link ",
	"felt unlink ",
	"felt upstream ",
	"felt downstream ",
	"felt graph ",
	"felt ready ",
	"felt find ",
	"felt prime ",
	"felt tapestry export",
}

func TestGeneratedGuidanceAvoidsRetiredCommands(t *testing.T) {
	for name, text := range map[string]string{
		"cliReference":    cliReference(),
		"claudeMDSnippet": claudeMDSnippet(),
		"minimalOutput":   minimalOutput(),
	} {
		for _, phrase := range retiredCommandPhrases {
			if strings.Contains(text, phrase) {
				t.Fatalf("%s contains retired command phrase %q", name, phrase)
			}
		}
	}
}

func TestRootCommandSurfaceIsConsolidated(t *testing.T) {
	var visible []string
	for _, cmd := range rootCmd.Commands() {
		if cmd.Hidden {
			continue
		}
		visible = append(visible, cmd.Name())
	}

	for _, retired := range []string{
		"tag",
		"untag",
		"link",
		"unlink",
		"comment",
		"upstream",
		"downstream",
		"graph",
		"ready",
		"find",
		"prime",
		"tapestry",
	} {
		if slices.Contains(visible, retired) {
			t.Fatalf("root command surface still exposes retired command %q in %v", retired, visible)
		}
	}

	for _, expected := range []string{
		"add",
		"check",
		"edit",
		"export",
		"hook",
		"init",
		"ls",
		"migrate",
		"nest",
		"rm",
		"setup",
		"show",
		"tree",
		"unnest",
		"update",
	} {
		if !slices.Contains(visible, expected) {
			t.Fatalf("root command surface missing %q in %v", expected, visible)
		}
	}

	if len(visible) > 16 {
		t.Fatalf("root command surface too large: got %d commands (%v)", len(visible), visible)
	}
}

func TestBundledSkillsAvoidRetiredCommands(t *testing.T) {
	root, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}

	candidates := []string{
		filepath.Join(root, "skills"),
		filepath.Join(root, "cmd", "skills"),
	}

	skillsRoot := ""
	for _, candidate := range candidates {
		info, err := os.Stat(candidate)
		if err == nil && info.IsDir() {
			skillsRoot = candidate
			break
		}
		if err != nil && !os.IsNotExist(err) {
			t.Fatalf("stat %s: %v", candidate, err)
		}
	}
	if skillsRoot == "" {
		t.Fatalf("could not find bundled skills directory from %s", root)
	}

	err = filepath.Walk(skillsRoot, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		text := string(data)
		for _, phrase := range retiredCommandPhrases {
			if strings.Contains(text, phrase) {
				t.Fatalf("%s contains retired command phrase %q", path, phrase)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", skillsRoot, err)
	}
}

func TestBundledSkillsAvoidLegacyCommentBodyEdits(t *testing.T) {
	root, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}

	candidates := []string{
		filepath.Join(root, "skills"),
		filepath.Join(root, "cmd", "skills"),
	}

	skillsRoot := ""
	for _, candidate := range candidates {
		info, err := os.Stat(candidate)
		if err == nil && info.IsDir() {
			skillsRoot = candidate
			break
		}
		if err != nil && !os.IsNotExist(err) {
			t.Fatalf("stat %s: %v", candidate, err)
		}
	}
	if skillsRoot == "" {
		t.Fatalf("could not find bundled skills directory from %s", root)
	}

	data, err := os.ReadFile(filepath.Join(skillsRoot, "felt", "references", "transcripts.md"))
	if err != nil {
		t.Fatalf("read transcripts reference: %v", err)
	}
	text := string(data)

	if strings.Contains(text, `felt edit <id> --body "$(felt show <id> --body)`) {
		t.Fatal("transcripts reference still teaches legacy body-overwrite comment editing")
	}
	if !strings.Contains(text, `felt edit <id> --comment "2025-01-21 14:30 — Update from meeting: progress on X"`) {
		t.Fatal("transcripts reference should teach consolidated edit --comment usage")
	}
}

func TestSetupSkillsLongMentionsActualBundledSkills(t *testing.T) {
	text := setupSkillsCmd.Long
	for _, name := range bundledSkillNames() {
		if !strings.Contains(text, name) {
			t.Fatalf("setup skills help missing bundled skill %q in %q", name, text)
		}
	}
	if strings.Contains(text, "tapestry") {
		t.Fatalf("setup skills help mentions non-bundled skill %q", "tapestry")
	}
}

func TestReadmeBundledSkillsMatchEmbeddedSkills(t *testing.T) {
	root, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(root, "README.md")); err == nil {
			break
		}
		parent := filepath.Dir(root)
		if parent == root {
			t.Fatal("could not find repository README.md")
		}
		root = parent
	}

	data, err := os.ReadFile(filepath.Join(root, "README.md"))
	if err != nil {
		t.Fatalf("read README: %v", err)
	}
	text := string(data)

	for _, name := range bundledSkillNames() {
		if !strings.Contains(text, "**"+name+"**") {
			t.Fatalf("README missing bundled skill %q", name)
		}
	}
	if strings.Contains(text, "**tapestry**") {
		t.Fatal("README lists non-bundled tapestry skill")
	}
}

func TestEmbeddedBundledSkillsAreSortedAndKnown(t *testing.T) {
	entries, err := fs.ReadDir(embeddedSkills, "skills")
	if err != nil {
		t.Fatalf("ReadDir embedded skills: %v", err)
	}

	var got []string
	for _, entry := range entries {
		if entry.IsDir() {
			got = append(got, entry.Name())
		}
	}

	want := slices.Clone(got)
	slices.Sort(want)

	if !slices.Equal(got, want) {
		t.Fatalf("embedded skill order = %v, want sorted %v", got, want)
	}
}
