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
		"export",
	} {
		if slices.Contains(visible, retired) {
			t.Fatalf("root command surface still exposes retired command %q in %v", retired, visible)
		}
	}

	for _, expected := range []string{
		"add",
		"check",
		"edit",
		"history",
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

func TestRootUsageAvoidsAddFlagLeakageAndBareAddShorthand(t *testing.T) {
	usage := rootCmd.UsageString()
	for _, leaked := range []string{"Body text", "Outcome (the conclusion)", "Status (open, active, closed)"} {
		if strings.Contains(usage, leaked) {
			t.Fatalf("root usage still leaks add-only flag %q:\n%s", leaked, usage)
		}
	}
	if strings.Contains(usage, "felt <slug> <name>") {
		t.Fatalf("root usage still advertises bare add shorthand:\n%s", usage)
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
	if strings.Contains(text, `felt edit <id> --comment`) {
		t.Fatal("transcripts reference should not teach legacy comment mutation")
	}
	if !strings.Contains(text, `edit .felt/<path>/<slug>.md directly`) {
		t.Fatal("transcripts reference should teach direct file edits for narrative updates")
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
	if strings.Contains(text, "extracted from title") {
		t.Fatal("README still documents legacy tag extraction on the name/title argument")
	}
}

func TestDocsAvoidLegacyTagExtractionExample(t *testing.T) {
	root, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(root, "docs", "README.md")); err == nil {
			break
		}
		parent := filepath.Dir(root)
		if parent == root {
			t.Fatal("could not find repository docs/README.md")
		}
		root = parent
	}

	data, err := os.ReadFile(filepath.Join(root, "docs", "README.md"))
	if err != nil {
		t.Fatalf("read docs/README.md: %v", err)
	}
	text := string(data)
	if strings.Contains(text, "extracted from title") {
		t.Fatal("docs/README.md still documents legacy tag extraction on the name/title argument")
	}
}

func TestGeneratedGuidanceAvoidsLegacyTitleDetailLevel(t *testing.T) {
	for name, text := range map[string]string{
		"cliReference":    cliReference(),
		"claudeMDSnippet": claudeMDSnippet(),
		"minimalOutput":   minimalOutput(),
	} {
		if strings.Contains(text, "title < compact") {
			t.Fatalf("%s still mentions legacy title detail level", name)
		}
		if strings.Contains(text, "Detail level (title, compact, summary, full)") {
			t.Fatalf("%s still mentions legacy title detail flag help", name)
		}
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
