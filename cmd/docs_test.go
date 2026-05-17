package cmd

import (
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
	// Only scan the in-binary string fixtures; the plugin tree (skills,
	// hooks, manifest) is scanned by TestPluginSkillsAvoidRetiredCommands.
	for name, text := range map[string]string{
		"claudeMDSnippet": claudeMDSnippet(),
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
		"index",
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

	// `hook` is back as a binary subcommand: the plugin's hook scripts are
	// thin shims that exec into it, so brew-upgrading the binary refreshes
	// hook behavior without requiring users to also refresh the plugin.
	if !slices.Contains(visible, "hook") {
		t.Fatalf("root command surface missing `hook` subcommand: %v", visible)
	}

	expectedVisible := []string{
		"add",
		"check",
		"edit",
		"history",
		"hook",
		"index",
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
	}
	slices.Sort(visible)
	visible = slices.DeleteFunc(visible, func(name string) bool { return name == "help" })
	if !slices.Equal(visible, expectedVisible) {
		t.Fatalf("root command surface mismatch:\n got %v\nwant %v", visible, expectedVisible)
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

// repoRoot walks up from the test's working directory until it finds go.mod.
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("could not find repo root (no go.mod)")
		}
		dir = parent
	}
}

// pluginSkillsRoot returns the claude-plugin/skills directory.
func pluginSkillsRoot(t *testing.T) string {
	t.Helper()
	root := repoRoot(t)

	candidates := []string{
		filepath.Join(root, "claude-plugin", "skills"),
		filepath.Join(root, "skills"),
	}
	for _, c := range candidates {
		if info, err := os.Stat(c); err == nil && info.IsDir() {
			return c
		}
	}
	t.Fatalf("could not find plugin skills directory from %s", root)
	return ""
}

// pluginSkillNames enumerates skill names from claude-plugin/skills/.
func pluginSkillNames(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(pluginSkillsRoot(t))
	if err != nil {
		t.Fatalf("ReadDir plugin skills: %v", err)
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() {
			names = append(names, e.Name())
		}
	}
	return names
}

func TestPluginSkillsAvoidRetiredCommands(t *testing.T) {
	skillsRoot := pluginSkillsRoot(t)

	err := filepath.Walk(skillsRoot, func(path string, info os.FileInfo, err error) error {
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

func TestPluginSkillsAvoidLegacyCommentBodyEdits(t *testing.T) {
	skillsRoot := pluginSkillsRoot(t)

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

func TestPluginSkillsAreSortedAndKnown(t *testing.T) {
	names := pluginSkillNames(t)
	sorted := make([]string, len(names))
	copy(sorted, names)
	slices.Sort(sorted)
	if !slices.Equal(names, sorted) {
		t.Fatalf("plugin skill order = %v, want sorted %v", names, sorted)
	}

	// felt and ralph must be present.
	for _, required := range []string{"felt", "ralph"} {
		if !slices.Contains(names, required) {
			t.Fatalf("plugin skills missing required skill %q (got %v)", required, names)
		}
	}
}

func TestReadmeListsPluginSkills(t *testing.T) {
	root := repoRoot(t)
	data, err := os.ReadFile(filepath.Join(root, "README.md"))
	if err != nil {
		t.Fatalf("read README: %v", err)
	}
	text := string(data)

	for _, name := range pluginSkillNames(t) {
		if !strings.Contains(text, "**"+name+"**") {
			t.Fatalf("README missing plugin skill %q", name)
		}
	}
	if strings.Contains(text, "**tapestry**") {
		t.Fatal("README lists retired tapestry skill")
	}
	if strings.Contains(text, "extracted from title") {
		t.Fatal("README still documents legacy tag extraction on the name/title argument")
	}
}

func TestDocsAvoidLegacyTagExtractionExample(t *testing.T) {
	root := repoRoot(t)
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
		"claudeMDSnippet": claudeMDSnippet(),
	} {
		if strings.Contains(text, "title < compact") {
			t.Fatalf("%s still mentions legacy title detail level", name)
		}
		if strings.Contains(text, "Detail level (title, compact, summary, full)") {
			t.Fatalf("%s still mentions legacy title detail flag help", name)
		}
	}
}

// TestPluginAssetsAvoidLegacyTitleDetailLevel walks the plugin tree (skills,
// hooks, manifest) for legacy detail-level phrasing.
func TestPluginAssetsAvoidLegacyTitleDetailLevel(t *testing.T) {
	root := repoRoot(t)
	pluginRoot := filepath.Join(root, "claude-plugin")
	if _, err := os.Stat(pluginRoot); err != nil {
		t.Skipf("no claude-plugin at %s: %v", pluginRoot, err)
	}
	err := filepath.Walk(pluginRoot, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		text := string(data)
		if strings.Contains(text, "title < compact") {
			t.Fatalf("%s still mentions legacy title detail level", path)
		}
		if strings.Contains(text, "Detail level (title, compact, summary, full)") {
			t.Fatalf("%s still mentions legacy title detail flag help", path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", pluginRoot, err)
	}
}
