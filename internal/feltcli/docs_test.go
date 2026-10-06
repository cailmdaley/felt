package feltcli

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv"
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
	"felt prime ",
	"felt tapestry export",
}

func TestGeneratedGuidanceAvoidsRetiredCommands(t *testing.T) {
	t.Parallel()
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
	t.Parallel()
	var visible []string
	for _, cmd := range NewRootCmd(sysenv.New(t.TempDir(), nil)).Commands() {
		if cmd.Hidden {
			continue
		}
		visible = append(visible, cmd.Name())
	}

	// `hook` is back as a binary subcommand: the plugin's hook scripts are
	// thin shims that exec into it, so brew-upgrading the binary refreshes
	// hook behavior without requiring users to also refresh the plugin.
	//
	// Shuttle commands are exposed by the separate shuttle binary.
	expectedVisible := []string{
		"add",
		"backfill-ids",
		"check",
		"edit",
		"find",
		"hook",
		"init",
		"ls",
		"migrate",
		"nest",
		"rm",
		"session",
		"setup",
		"show",
		"sync",
		"tree",
		"uninstall",
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
	t.Parallel()
	usage := NewRootCmd(sysenv.New(t.TempDir(), nil)).UsageString()
	for _, leaked := range []string{"Body text", "Outcome: what was decided", "Status (open, active, closed)"} {
		if strings.Contains(usage, leaked) {
			t.Fatalf("root usage still leaks add-only flag %q:\n%s", leaked, usage)
		}
	}
	if strings.Contains(usage, "felt <slug> <name>") {
		t.Fatalf("root usage still advertises bare add shorthand:\n%s", usage)
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

// forbidUnder walks root (filtering by ext when non-empty) and reports every
// file containing any of the phrases. Errorf, not Fatalf: one run should name
// every offender, not just the first.
func forbidUnder(t *testing.T, root, ext string, phrases ...string) {
	t.Helper()
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || (ext != "" && filepath.Ext(path) != ext) {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, phrase := range phrases {
			if strings.Contains(string(data), phrase) {
				t.Errorf("%s contains forbidden phrase %q", path, phrase)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
}

func TestPluginSkillsAvoidRetiredCommands(t *testing.T) {
	t.Parallel()
	forbidUnder(t, pluginSkillsRoot(t), "", retiredCommandPhrases...)
}

func TestPluginSkillsAvoidLegacyCommentBodyEdits(t *testing.T) {
	t.Parallel()
	skillsRoot := pluginSkillsRoot(t)

	data, err := os.ReadFile(filepath.Join(skillsRoot, "shuttle", "references", "meeting.md"))
	if err != nil {
		t.Fatalf("read meeting reference: %v", err)
	}
	text := string(data)

	if strings.Contains(text, `felt edit <id> --body "$(felt show <id> --body)`) {
		t.Fatal("meeting reference still teaches legacy body-overwrite comment editing")
	}
	if strings.Contains(text, `felt edit <id> --comment`) {
		t.Fatal("meeting reference should not teach legacy comment mutation")
	}
	if !strings.Contains(text, "edit `.felt/<path>/<slug>.md` directly") {
		t.Fatal("meeting reference should teach direct file edits for narrative updates")
	}
}

func TestPluginSkillsAreSortedAndKnown(t *testing.T) {
	t.Parallel()
	names := pluginSkillNames(t)
	sorted := make([]string, len(names))
	copy(sorted, names)
	slices.Sort(sorted)
	if !slices.Equal(names, sorted) {
		t.Fatalf("plugin skill order = %v, want sorted %v", names, sorted)
	}

	// felt must be present. (ralph was retired in abb0857.)
	for _, required := range []string{"felt"} {
		if !slices.Contains(names, required) {
			t.Fatalf("plugin skills missing required skill %q (got %v)", required, names)
		}
	}
}

func TestReadmeListsPluginSkills(t *testing.T) {
	t.Parallel()
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
	t.Parallel()
	docsDir := filepath.Join(repoRoot(t), "docs")
	if _, err := os.Stat(docsDir); err != nil {
		t.Fatalf("could not find repository docs/: %v", err)
	}
	forbidUnder(t, docsDir, ".md", "extracted from title")
}

func TestGeneratedGuidanceAvoidsLegacyTitleDetailLevel(t *testing.T) {
	t.Parallel()
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
	t.Parallel()
	pluginRoot := filepath.Join(repoRoot(t), "claude-plugin")
	if _, err := os.Stat(pluginRoot); err != nil {
		t.Skipf("no claude-plugin at %s: %v", pluginRoot, err)
	}
	forbidUnder(t, pluginRoot, "", "title < compact", "Detail level (title, compact, summary, full)")
}
