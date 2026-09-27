package felt

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mustExtra(t *testing.T, f *Felt, key string, value any) {
	t.Helper()
	if err := f.SetExtraField(key, value); err != nil {
		t.Fatalf("SetExtraField(%s): %v", key, err)
	}
}

func TestCheckBrokenBodyReference(t *testing.T) {
	issues := Check([]*Felt{{
		ID:   "fiber-a",
		Name: "Fiber A",
		Body: "See [[missing]].",
	}}, nil)

	if len(issues) != 1 {
		t.Fatalf("Check() produced %d issues, want 1", len(issues))
	}
	if issues[0].Path != "body" {
		t.Fatalf("issue path = %q, want body", issues[0].Path)
	}
	if !strings.Contains(issues[0].Message, "broken body reference") {
		t.Fatalf("issue message = %q, want broken body reference", issues[0].Message)
	}
}

func TestCheckEmptyName(t *testing.T) {
	issues := Check([]*Felt{{ID: "blank-name", Name: "  "}}, nil)

	if len(issues) != 1 {
		t.Fatalf("Check() produced %d issues, want 1", len(issues))
	}
	if issues[0].Path != "frontmatter.name" {
		t.Fatalf("issue path = %q, want frontmatter.name", issues[0].Path)
	}
	if !strings.Contains(issues[0].Message, "name cannot be empty") {
		t.Fatalf("issue message = %q, want empty-name failure", issues[0].Message)
	}
}

func TestCheckBrokenBodyReferenceFragmentAgainstOpaqueFrontmatter(t *testing.T) {
	target := &Felt{ID: "fiber-b", Name: "Fiber B"}
	mustExtra(t, target, "decisions", map[string]any{
		"choice": map[string]any{"label": "Choice"},
	})

	issues := Check([]*Felt{
		{ID: "fiber-a", Name: "Fiber A", Body: "See [[fiber-b#missing-element]]."},
		target,
	}, nil)

	if len(issues) != 1 {
		t.Fatalf("Check() produced %d issues, want 1", len(issues))
	}
	if issues[0].Path != "body" {
		t.Fatalf("issue path = %q, want body", issues[0].Path)
	}
	if !strings.Contains(issues[0].Message, `has no element "missing-element"`) {
		t.Fatalf("issue message = %q, want missing element failure", issues[0].Message)
	}
}

func TestCheckBrokenDataFlowReference(t *testing.T) {
	fiber := &Felt{ID: "fiber-a", Name: "Fiber A"}
	mustExtra(t, fiber, "inputs", []map[string]any{{
		"id":   "catalog",
		"from": "missing.output",
	}})

	issues := Check([]*Felt{fiber}, nil)
	if len(issues) != 1 {
		t.Fatalf("Check() produced %d issues, want 1", len(issues))
	}
	if issues[0].Path != "inputs.catalog.from" {
		t.Fatalf("issue path = %q, want inputs.catalog.from", issues[0].Path)
	}
	if !strings.Contains(issues[0].Message, "broken data-flow reference") {
		t.Fatalf("issue message = %q, want broken data-flow reference", issues[0].Message)
	}
}

func TestCheckBrokenDataFlowOutputReference(t *testing.T) {
	consumer := &Felt{ID: "fiber-a", Name: "Fiber A"}
	mustExtra(t, consumer, "inputs", []map[string]any{{
		"id":   "catalog",
		"from": "fiber-b.missing-output",
	}})
	producer := &Felt{ID: "fiber-b", Name: "Fiber B"}
	mustExtra(t, producer, "outputs", []map[string]any{{"id": "present-output"}})

	issues := Check([]*Felt{consumer, producer}, nil)
	if len(issues) != 1 {
		t.Fatalf("Check() produced %d issues, want 1", len(issues))
	}
	if issues[0].Path != "inputs.catalog.from" {
		t.Fatalf("issue path = %q, want inputs.catalog.from", issues[0].Path)
	}
	if !strings.Contains(issues[0].Message, `has no output "missing-output"`) {
		t.Fatalf("issue message = %q, want missing output failure", issues[0].Message)
	}
}

func TestCheckLegacyFormatReportsTitleDependsOnAndMystAnchor(t *testing.T) {
	dir, s := newStore(t)

	content := `---
title: Legacy Fiber
depends-on:
  - upstream
created-at: 2026-04-10T10:00:00Z
---

(legacy-fiber)=

Body.
`
	path := filepath.Join(dir, DirName, "legacy-fiber", "legacy-fiber.md")
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("mkdir legacy fiber: %v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("write legacy fiber: %v", err)
	}

	issues, err := CheckLegacyFormat(s)
	if err != nil {
		t.Fatalf("CheckLegacyFormat() error: %v", err)
	}
	if len(issues) != 3 {
		t.Fatalf("CheckLegacyFormat() produced %d issues, want 3", len(issues))
	}
	bodyIssue := false
	titleIssue := false
	dependsOnIssue := false
	for _, issue := range issues {
		if issue.Path == "body" && strings.Contains(issue.Message, "legacy MyST anchor") {
			bodyIssue = true
		}
		if issue.Path == "frontmatter" && strings.Contains(issue.Message, `"title"`) {
			titleIssue = true
		}
		if issue.Path == "frontmatter" && strings.Contains(issue.Message, `"depends-on"`) {
			dependsOnIssue = true
		}
	}
	if !bodyIssue {
		t.Fatalf("issues = %#v, want body issue", issues)
	}
	if !titleIssue || !dependsOnIssue {
		t.Fatalf("issues = %#v, want title and depends-on frontmatter issues", issues)
	}
}

func TestCheckLegacyFormatSkipsMalformedFrontmatter(t *testing.T) {
	dir, s := newStore(t)

	path := filepath.Join(dir, DirName, "broken-fiber", "broken-fiber.md")
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("mkdir broken fiber: %v", err)
	}
	content := "---\nname: Broken Fiber\ncreated-at: 2026-04-10T10:00:00Z\noutcome: Backticks: `value`\n---\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("write broken fiber: %v", err)
	}

	issues, err := CheckLegacyFormat(s)
	if err != nil {
		t.Fatalf("CheckLegacyFormat() error: %v", err)
	}
	if len(issues) != 0 {
		t.Fatalf("CheckLegacyFormat() issues = %#v, want none", issues)
	}
}

func TestCheckStructureMultipleBareFibers(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	os.WriteFile(filepath.Join(s.root, "alpha.md"), []byte("---\nname: alpha\n---\n"), 0644)
	os.WriteFile(filepath.Join(s.root, "beta.md"), []byte("---\nname: beta\n---\n"), 0644)

	issues, err := CheckStructure(s)
	if err != nil {
		t.Fatalf("CheckStructure: %v", err)
	}
	if len(issues) != 1 || issues[0].Level != CheckLevelError {
		t.Fatalf("issues = %+v, want 1 error", issues)
	}
	if !strings.Contains(issues[0].Message, "multiple bare fiber files") {
		t.Fatalf("message = %q, want multiple-bare error", issues[0].Message)
	}
}

func TestCheckStructureSlugCollision(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	os.WriteFile(filepath.Join(s.root, "cmbx.md"), []byte("---\nname: bare\n---\n"), 0644)
	nestedDir := filepath.Join(s.root, "cmbx")
	os.MkdirAll(nestedDir, 0755)
	os.WriteFile(filepath.Join(nestedDir, "cmbx.md"), []byte("---\nname: nested\n---\n"), 0644)

	issues, err := CheckStructure(s)
	if err != nil {
		t.Fatalf("CheckStructure: %v", err)
	}
	found := false
	for _, i := range issues {
		if strings.Contains(i.Message, "slug collision") {
			found = true
			if i.Level != CheckLevelError {
				t.Errorf("collision level = %q, want error", i.Level)
			}
		}
	}
	if !found {
		t.Fatalf("no slug-collision issue reported, got: %+v", issues)
	}
}

func TestCheckStructureCleanRepo(t *testing.T) {
	dir := t.TempDir()
	s := NewStorage(dir)
	s.Init()

	os.WriteFile(filepath.Join(s.root, "cmbx.md"), []byte("---\nname: root\n---\n"), 0644)
	childDir := filepath.Join(s.root, "background")
	os.MkdirAll(childDir, 0755)
	os.WriteFile(filepath.Join(childDir, "background.md"), []byte("---\nname: bg\n---\n"), 0644)

	issues, err := CheckStructure(s)
	if err != nil {
		t.Fatalf("CheckStructure: %v", err)
	}
	if len(issues) != 0 {
		t.Fatalf("issues = %+v, want none", issues)
	}
}

// TestCheckSkipsEnclosingStoreReferences: from inside a substore, a wikilink
// to a fiber elsewhere in the enclosing store is healthy — this view just
// cannot see it — while a link to nothing anywhere is still an error.
func TestCheckSkipsEnclosingStoreReferences(t *testing.T) {
	_, subProj := newSubstoreFixture(t)
	external := NewStorage(subProj).ExternalRefs()

	issues := Check([]*Felt{
		{ID: "debug", Name: "Debug"},
		{
			ID:   "notes/runbook",
			Name: "Runbook",
			Body: "Elsewhere: [[ai-futures/portolan/debug]] and [[commons]]. Here: [[debug]]. Gone: [[nowhere-at-all]].",
		},
	}, external)

	var errorIssues, infoIssues []CheckIssue
	for _, issue := range issues {
		if issue.Level == CheckLevelError {
			errorIssues = append(errorIssues, issue)
		} else if issue.Level == CheckLevelInfo {
			infoIssues = append(infoIssues, issue)
		}
	}
	if len(errorIssues) != 1 {
		t.Fatalf("Check() produced %d errors, want 1: %v", len(errorIssues), issues)
	}
	if !strings.Contains(errorIssues[0].Message, "nowhere-at-all") {
		t.Fatalf("issue = %q, want the genuinely broken reference", errorIssues[0].Message)
	}

	// [[ai-futures/portolan/debug]] names the fiber's path exactly, from the
	// enclosing store's root — someone wrote the id they meant. The local
	// `debug` twin does not make that remarkable, so check stays silent.
	if len(infoIssues) != 0 {
		t.Fatalf("a fully-qualified outer link should be silent, got %v", infoIssues)
	}
}

// TestCheckReportsShadowedBasenameRescue: when the enclosing store INFERS the
// target — its own scope/suffix/basename rules, not a path written out in
// full — and a local basename rescue would otherwise have fired, the reader
// loses a repair. Check names both candidates rather than losing it silently.
func TestCheckReportsShadowedBasenameRescue(t *testing.T) {
	_, subProj := newSubstoreFixture(t)
	external := NewStorage(subProj).ExternalRefs()

	issues := Check([]*Felt{
		{ID: "debug", Name: "Debug"},
		{ID: "notes/runbook", Name: "Runbook", Body: "Partial: [[portolan/debug]]."},
	}, external)

	if len(issues) != 1 || issues[0].Level != CheckLevelInfo {
		t.Fatalf("want one info issue, got %v", issues)
	}
	for _, want := range []string{"ai-futures/portolan/debug", "shadow", "debug"} {
		if !strings.Contains(issues[0].Message, want) {
			t.Fatalf("info issue = %q, want it to name %q", issues[0].Message, want)
		}
	}
}

// TestRelationshipsDropForeignCitations: a link that resolves out into the
// enclosing store is not a citation of the local same-slug fiber. Only the
// genuinely local reference counts.
func TestRelationshipsDropForeignCitations(t *testing.T) {
	_, subProj := newSubstoreFixture(t)
	external := NewStorage(subProj).ExternalRefs()

	felts := []*Felt{
		{ID: "debug", Name: "Debug"},
		{ID: "notes/runbook", Name: "Runbook", Body: "Elsewhere: [[ai-futures/portolan/debug]]."},
		{ID: "notes/here", Name: "Here", Body: "Local: [[debug]]."},
	}
	citations, _, err := RelationshipsFromFelts(felts, "debug", external)
	if err != nil {
		t.Fatalf("RelationshipsFromFelts() error: %v", err)
	}
	if len(citations) != 1 || citations[0].SourceID != "notes/here" {
		t.Fatalf("citations = %+v, want only the local reference from notes/here", citations)
	}
}

func TestCheckParseabilityReportsMalformedFrontmatterAsError(t *testing.T) {
	dir, s := newStore(t)

	// The failure from the field: an unquoted scalar carrying a colon-space,
	// which YAML reads as a nested mapping.
	content := `---
name: Venue
created-at: 2026-04-10T10:00:00Z
outcome: booked 8/1: deposit paid
---

Body.
`
	path := filepath.Join(dir, DirName, "venue", "venue.md")
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("mkdir venue: %v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("write venue fiber: %v", err)
	}

	issues, err := CheckParseability(s)
	if err != nil {
		t.Fatalf("CheckParseability() error: %v", err)
	}
	if len(issues) != 1 {
		t.Fatalf("issues = %+v, want exactly one", issues)
	}
	if issues[0].Level != CheckLevelError {
		t.Fatalf("level = %q, want %q — an invisible fiber is not a warning", issues[0].Level, CheckLevelError)
	}
	if issues[0].FiberID != "venue" {
		t.Fatalf("fiber id = %q, want %q", issues[0].FiberID, "venue")
	}
	// The walk resolves symlinks (macOS /var → /private/var), so compare
	// against the resolved form.
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatalf("EvalSymlinks: %v", err)
	}
	if issues[0].Path != resolved {
		t.Fatalf("path = %q, want %q", issues[0].Path, resolved)
	}
	if !strings.Contains(issues[0].Message, "mapping values are not allowed") {
		t.Fatalf("message = %q, want the YAML parse error", issues[0].Message)
	}
	// The path belongs in Path, not doubled into the message.
	if strings.Contains(issues[0].Message, resolved) {
		t.Fatalf("message repeats the path: %q", issues[0].Message)
	}
}

func TestCheckParseabilityQuietOnHealthyStore(t *testing.T) {
	_, s := newStore(t)
	if err := s.Write(&Felt{ID: "fiber-a", Name: "Fiber A"}); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	issues, err := CheckParseability(s)
	if err != nil {
		t.Fatalf("CheckParseability() error: %v", err)
	}
	if len(issues) != 0 {
		t.Fatalf("issues = %+v, want none", issues)
	}
}

// TestCheckParseabilitySurvivesFeltWrittenColonOutcomes guards the boundary
// this check sits on: felt's own write path quotes correctly, so a colon-space
// outcome written through the CLI must NOT be reported. Only hand-edited
// frontmatter can land here.
func TestCheckParseabilitySurvivesFeltWrittenColonOutcomes(t *testing.T) {
	_, s := newStore(t)
	if err := s.Write(&Felt{ID: "venue", Name: "Venue", Outcome: "booked 8/1: deposit paid"}); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	issues, err := CheckParseability(s)
	if err != nil {
		t.Fatalf("CheckParseability() error: %v", err)
	}
	if len(issues) != 0 {
		t.Fatalf("issues = %+v, want none — felt's own writes must round-trip", issues)
	}
}

func TestCheckDependsOnScalarRefOK(t *testing.T) {
	dependent := &Felt{ID: "fiber-a", Name: "Fiber A"}
	mustExtra(t, dependent, "depends_on", "fiber-b")

	issues := Check([]*Felt{dependent, {ID: "fiber-b", Name: "Fiber B"}}, nil)
	if len(issues) != 0 {
		t.Fatalf("Check() issues = %+v, want none", issues)
	}
}

func TestCheckDependsOnListRefOK(t *testing.T) {
	dependent := &Felt{ID: "fiber-a", Name: "Fiber A"}
	mustExtra(t, dependent, "depends_on", []string{"fiber-b", "fiber-c"})

	issues := Check([]*Felt{
		dependent,
		{ID: "fiber-b", Name: "Fiber B"},
		{ID: "fiber-c", Name: "Fiber C"},
	}, nil)
	if len(issues) != 0 {
		t.Fatalf("Check() issues = %+v, want none", issues)
	}
}

func TestCheckDependsOnMapEntryOK(t *testing.T) {
	dependent := &Felt{ID: "fiber-a", Name: "Fiber A"}
	mustExtra(t, dependent, "depends_on", []map[string]any{{"id": "fiber-b"}})

	issues := Check([]*Felt{dependent, {ID: "fiber-b", Name: "Fiber B"}}, nil)
	if len(issues) != 0 {
		t.Fatalf("Check() issues = %+v, want none", issues)
	}
}

func TestCheckDependsOnDanglingRef(t *testing.T) {
	dependent := &Felt{ID: "fiber-a", Name: "Fiber A"}
	mustExtra(t, dependent, "depends_on", "missing-fiber")

	issues := Check([]*Felt{dependent}, nil)
	if len(issues) != 1 {
		t.Fatalf("Check() issues = %+v, want 1", issues)
	}
	if issues[0].Path != "frontmatter.depends_on" {
		t.Fatalf("issue path = %q, want frontmatter.depends_on", issues[0].Path)
	}
	if !strings.Contains(issues[0].Message, `dangling depends_on reference "missing-fiber"`) {
		t.Fatalf("issue message = %q, want dangling depends_on reference", issues[0].Message)
	}
}

func TestCheckDependsOnMalformedEntry(t *testing.T) {
	dependent := &Felt{ID: "fiber-a", Name: "Fiber A"}
	mustExtra(t, dependent, "depends_on", []map[string]any{{"not-id": "fiber-b"}})

	issues := Check([]*Felt{dependent, {ID: "fiber-b", Name: "Fiber B"}}, nil)
	if len(issues) != 1 {
		t.Fatalf("Check() issues = %+v, want 1", issues)
	}
	if issues[0].Path != "frontmatter.depends_on" {
		t.Fatalf("issue path = %q, want frontmatter.depends_on", issues[0].Path)
	}
	if !strings.Contains(issues[0].Message, "malformed depends_on entry") {
		t.Fatalf("issue message = %q, want malformed depends_on entry", issues[0].Message)
	}
}

// A TOP-LEVEL `depends_on: {id: …}` is malformed, however reasonable it looks.
// No reader honors it: the board's parser ignores a bare mapping and the
// poller iterates it as {key, value} tuples its dep_id/1 answers nil for, so
// the fiber is gated forever with nothing on screen to say why. The checker is
// the only place that can say so — it must not bless a shape the runtime
// refuses.
func TestCheckDependsOnTopLevelMapIsMalformed(t *testing.T) {
	dependent := &Felt{ID: "fiber-a", Name: "Fiber A"}
	mustExtra(t, dependent, "depends_on", map[string]any{"id": "fiber-b"})

	issues := Check([]*Felt{dependent, {ID: "fiber-b", Name: "Fiber B"}}, nil)
	if len(issues) != 1 {
		t.Fatalf("Check() issues = %+v, want 1", issues)
	}
	if !strings.Contains(issues[0].Message, "malformed depends_on entry") {
		t.Fatalf("issue message = %q, want malformed depends_on entry", issues[0].Message)
	}
}

// `depends_on:` with nothing after it is ABSENCE. The poller normalizes nil to
// "no dependencies" and the board ignores it, so a checker complaint here
// would be a rule only the checker believes in — and one that fires on a line
// someone left behind after clearing a dependency, which is exactly the moment
// they were being tidy.
func TestCheckDependsOnNullIsAbsent(t *testing.T) {
	// Parsed from real frontmatter rather than built with SetExtraField: the
	// bug is about the yaml NODE a bare `depends_on:` produces (a !!null
	// scalar), and only the parse path produces one.
	dependent, err := Parse("fiber-a", []byte("---\nname: Fiber A\nstatus: open\ndepends_on:\n---\n"))
	if err != nil {
		t.Fatalf("Parse() error: %v", err)
	}

	issues := Check([]*Felt{dependent}, nil)
	if len(issues) != 0 {
		t.Fatalf("Check() issues = %+v, want none — an empty depends_on is not a dependency", issues)
	}
}

// writeFile plants raw bytes at a path under root, creating parents.
func writeFile(t *testing.T, root, rel, content string) string {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
		t.Fatalf("mkdir %s: %v", rel, err)
	}
	if err := os.WriteFile(p, []byte(content), 0644); err != nil {
		t.Fatalf("write %s: %v", rel, err)
	}
	return p
}

// TestCheckStructureFlagsStrayFiberFile: a bare `<dir>/<slug>.md` carrying
// fiber frontmatter below the root is a layout error naming the file and its
// directory-form home, and it ends with the migrate hint so the session hook
// can tell it apart. Markdown companions beside it — no frontmatter at all, or
// frontmatter that names nothing — are not fibers and draw no issue, and
// nothing under a hidden directory is inspected.
func TestCheckStructureFlagsStrayFiberFile(t *testing.T) {
	_, s := newStore(t)
	writeRawFiber(t, s.root, "parent")
	writeFile(t, s.root, "parent/leaf.md", "---\nname: leaf\ntags: [x]\n---\n")
	writeFile(t, s.root, "parent/survey.md", "# `cosmo_val` design-check survey\n\nA plain companion report.\n")
	writeFile(t, s.root, "parent/talk.md", "---\ndate: 2026-01-01\n---\nslides\n")
	writeFile(t, s.root, "parent/SKILL.md", "---\nname: parent-skill\ndescription: A skill kept beside its fiber.\n---\n")
	writeFile(t, s.root, ".trash/binned.md", "---\nname: binned\n---\n")

	issues, err := CheckStructure(s)
	if err != nil {
		t.Fatalf("CheckStructure: %v", err)
	}
	if len(issues) != 1 {
		t.Fatalf("issues = %+v, want exactly the stray leaf", issues)
	}
	got := issues[0]
	if got.Level != CheckLevelError || got.FiberID != "parent/leaf" {
		t.Fatalf("issue = %+v, want error on parent/leaf", got)
	}
	for _, want := range []string{".felt/parent/leaf.md", ".felt/parent/leaf/leaf.md"} {
		if !strings.Contains(got.Message, want) {
			t.Errorf("message %q does not name %s", got.Message, want)
		}
	}
	if !strings.HasSuffix(got.Message, LegacyFlatMigrationHint) || !got.FixedByMigrate() {
		t.Errorf("message %q should end with the migrate hint", got.Message)
	}
}

// TestCheckStructureStrayFiberCollision: when the directory-form home is
// already taken, migrate cannot fold the file, so check says so instead of
// recommending it.
func TestCheckStructureStrayFiberCollision(t *testing.T) {
	_, s := newStore(t)
	writeRawFiber(t, s.root, "parent/leaf")
	writeFile(t, s.root, "parent/leaf.md", "---\nname: other leaf\ntags: [x]\n---\n")

	issues, err := CheckStructure(s)
	if err != nil {
		t.Fatalf("CheckStructure: %v", err)
	}
	if len(issues) != 1 || !strings.Contains(issues[0].Message, "slug collision") {
		t.Fatalf("issues = %+v, want one slug collision", issues)
	}
	if issues[0].FixedByMigrate() {
		t.Errorf("a collision is not something migrate fixes: %q", issues[0].Message)
	}
}

// TestCheckRootFlatFilesRecommendMigrate: the root-level flat-file error and
// the nested stray error share the migrate hint.
func TestCheckRootFlatFilesRecommendMigrate(t *testing.T) {
	_, s := newStore(t)
	writeFile(t, s.root, "alpha.md", "---\nname: alpha\n---\n")
	writeFile(t, s.root, "beta.md", "---\nname: beta\n---\n")

	issues, err := CheckStructure(s)
	if err != nil {
		t.Fatalf("CheckStructure: %v", err)
	}
	if len(issues) != 1 || issues[0].FiberID != "." || !issues[0].FixedByMigrate() {
		t.Fatalf("issues = %+v, want one root flat-file error recommending migrate", issues)
	}
}

// TestCheckWarnsOnSlugRescuedReference: a link whose written path matches
// nothing still resolves through the basename rescue, but check warns and
// names the fiber's real path. Every other way a link resolves — exact id,
// relative to the citing fiber's scope, a bare slug, a correct partial tail —
// is how links are meant to be written and stays silent.
func TestCheckWarnsOnSlugRescuedReference(t *testing.T) {
	consumer := &Felt{ID: "notes", Name: "Notes"}
	mustExtra(t, consumer, "inputs", []map[string]any{{"id": "cov", "from": "old/jackknife.matrix"}})
	target := &Felt{ID: "proj1/a2/jackknife", Name: "Jackknife"}
	mustExtra(t, target, "outputs", []map[string]any{{"id": "matrix"}})

	issues := Check([]*Felt{
		{ID: "proj1", Name: "P"},
		{ID: "proj1/a2", Name: "A2"},
		target,
		{ID: "proj1/a2/sibling", Name: "Sibling", Body: "[[jackknife]] and [[a2/jackknife]] and [[proj1/a2/jackknife]]"},
		{ID: "proj1/other", Name: "Other", Body: "[[a2/jackknife]] relative to proj1"},
		{ID: "elsewhere", Name: "Elsewhere", Body: "[[jackknife]] [[a2/jackknife]] [[bogus/jackknife|the estimate]]"},
		consumer,
	}, nil)

	var warnings []CheckIssue
	for _, issue := range issues {
		if issue.Level != CheckLevelWarning {
			t.Errorf("unexpected issue: %s", issue)
			continue
		}
		warnings = append(warnings, issue)
	}
	if len(warnings) != 2 {
		t.Fatalf("warnings = %+v, want the two stale paths", warnings)
	}
	body, flow := warnings[0], warnings[1]
	if body.FiberID != "elsewhere" || body.Path != "body" ||
		body.Message != `stale path in reference "bogus/jackknife": no fiber lives there; it resolves to proj1/a2/jackknife only by its final segment` {
		t.Errorf("body warning = %+v", body)
	}
	if flow.FiberID != "notes" || flow.Path != "inputs.cov.from" ||
		flow.Message != `stale path in reference "old/jackknife.matrix": no fiber lives there; it resolves to proj1/a2/jackknife only by its final segment` {
		t.Errorf("data-flow warning = %+v", flow)
	}
}

// TestCheckLinkToStrayIsBrokenNotRescued: a link naming a stray fiber file's
// id is broken until migrate folds the file. The slug rescue must not answer
// it with a same-named fiber elsewhere, and check must not advise rewriting
// the link toward that twin.
func TestCheckLinkToStrayIsBrokenNotRescued(t *testing.T) {
	_, s := newStore(t)
	writeRawFiber(t, s.root, "proj/a")
	writeRawFiber(t, s.root, "x/leaf2")
	writeStray(t, s.root, "proj/a/leaf2.md")
	strays, err := s.StrayFibers()
	if err != nil {
		t.Fatalf("StrayFibers: %v", err)
	}

	issues := Check([]*Felt{
		{ID: "proj", Name: "P"},
		{ID: "proj/a", Name: "A", Body: "[[leaf2]]"},
		{ID: "x", Name: "X"},
		{ID: "x/leaf2", Name: "Twin"},
		{ID: "citer", Name: "Citer", Body: "[[proj/a/leaf2]]"},
	}, nil, strays...)

	if len(issues) != 2 {
		t.Fatalf("issues = %+v, want both links broken", issues)
	}
	for _, issue := range issues {
		if issue.Level != CheckLevelError || !strings.Contains(issue.Message, "broken body reference") ||
			!strings.Contains(issue.Message, ".felt/proj/a/leaf2.md is a stray fiber file") || !issue.FixedByMigrate() {
			t.Errorf("issue = %s", issue)
		}
	}
}
