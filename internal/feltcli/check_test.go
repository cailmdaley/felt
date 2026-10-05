package feltcli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestCheckCommandReportsIssues(t *testing.T) {
	dir, storage := newStore(t)

	fiber := &felt.Felt{ID: "fiber-a"}
	if err := fiber.SetExtraField("inputs", []map[string]any{{"id": "catalog", "from": "missing.output"}}); err != nil {
		t.Fatalf("SetExtraField: %v", err)
	}
	if err := storage.Write(fiber); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	output, err := runCommand(t, dir, "check")
	if err == nil {
		t.Fatal("felt check succeeded unexpectedly")
	}
	if !strings.Contains(output, "broken data-flow reference") {
		t.Fatalf("missing lint output:\n%s", output)
	}
}

func TestCheckCommandNamesLegacyFlatMigration(t *testing.T) {
	dir, storage := newStore(t)
	for _, name := range []string{"old-thing-1a2b3c4d", "other-9f8e7d6c"} {
		content := "---\nname: " + name + "\n---\n"
		if err := os.WriteFile(filepath.Join(storage.Root(), name+".md"), []byte(content), 0644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}

	output, err := runCommand(t, dir, "check")
	if err == nil {
		t.Fatalf("felt check succeeded for a legacy flat store:\n%s", output)
	}
	for _, want := range []string{
		"multiple bare fiber files at .felt/ root",
		"old-thing-1a2b3c4d, other-9f8e7d6c",
		"run `felt migrate --dry-run`, then `felt migrate`",
	} {
		if !strings.Contains(output, want) {
			t.Fatalf("check output missing %q:\n%s", want, output)
		}
	}
}

func TestCheckCommandJSONExitsNonZeroOnError(t *testing.T) {
	dir, storage := newStore(t)

	fiber := &felt.Felt{ID: "fiber-a"}
	if err := fiber.SetExtraField("inputs", []map[string]any{{"id": "catalog", "from": "missing.output"}}); err != nil {
		t.Fatalf("SetExtraField: %v", err)
	}
	if err := storage.Write(fiber); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	output, err := runCommand(t, dir, "check", "--json")
	if err == nil {
		t.Fatal("felt check --json succeeded despite an error-level issue")
	}
	if !strings.HasPrefix(strings.TrimSpace(output), "[") {
		t.Fatalf("expected a JSON array on stdout:\n%s", output)
	}
}

func TestCheckCommandSucceedsWhenOnlySubstrateChecksPass(t *testing.T) {
	dir, storage := newStore(t)

	fiber := &felt.Felt{ID: "fiber-a", Name: "Fiber A", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}
	if err := fiber.SetExtraField("decisions", map[string]any{
		"choice": map[string]any{"label": "Choice"},
	}); err != nil {
		t.Fatalf("SetExtraField: %v", err)
	}
	if err := storage.Write(fiber); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	output, err := runCommand(t, dir, "check")
	if err != nil {
		t.Fatalf("felt check returned error unexpectedly: %v\n%s", err, output)
	}
	if !strings.Contains(output, "Check OK") {
		t.Fatalf("missing success summary:\n%s", output)
	}
}

func TestCheckCommandReportsLegacyFormatIssues(t *testing.T) {
	dir, _ := newStore(t)

	path := filepath.Join(dir, ".felt", "legacy-fiber", "legacy-fiber.md")
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("mkdir legacy fiber: %v", err)
	}
	content := `---
title: Legacy Fiber
depends-on:
  - upstream
created-at: 2026-04-10T10:00:00Z
---

(legacy-fiber)=

Body.
`
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("write legacy fiber: %v", err)
	}

	output, err := runCommand(t, dir, "check")
	if err == nil {
		t.Fatal("felt check succeeded unexpectedly")
	}
	if !strings.Contains(output, `legacy frontmatter key "title" should be renamed to "name"`) {
		t.Fatalf("missing legacy title lint output:\n%s", output)
	}
	if !strings.Contains(output, `legacy frontmatter key "depends-on" should be removed`) {
		t.Fatalf("missing legacy depends-on lint output:\n%s", output)
	}
	if !strings.Contains(output, "legacy MyST anchor should be removed") {
		t.Fatalf("missing legacy anchor lint output:\n%s", output)
	}
}

// TestCheckCommandCountsUnparseableFiberFirst pins the fix for a store where a
// fiber had been invisible for three weeks. Its `outcome:` was a bare unquoted
// scalar containing a colon-space, which YAML reads as a nested mapping; the
// file stopped parsing, the listing walk skipped it with a stderr warning, and
// `felt check` — the command whose whole job is finding problems — did not
// count it. A fiber can drop out of the assemblage entirely; check must say so,
// first, and fail.
func TestCheckCommandCountsUnparseableFiberFirst(t *testing.T) {
	dir, storage := newStore(t)

	// A second, lesser problem: a broken body reference. It must still be
	// reported — and must come after the fiber that no longer exists.
	linker := &felt.Felt{ID: "linker", Name: "Linker", Body: "See [[nowhere]]."}
	if err := storage.Write(linker); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	brokenPath := filepath.Join(dir, ".felt", "venue", "venue.md")
	if err := os.MkdirAll(filepath.Dir(brokenPath), 0755); err != nil {
		t.Fatalf("mkdir venue: %v", err)
	}
	broken := `---
name: Venue
created-at: 2026-04-10T10:00:00Z
outcome: booked 8/1: deposit paid
---

Body.
`
	if err := os.WriteFile(brokenPath, []byte(broken), 0644); err != nil {
		t.Fatalf("write venue fiber: %v", err)
	}

	// The fiber really is invisible to the rest of felt — the premise of the
	// whole check.
	felts, err := storage.List()
	if err != nil {
		t.Fatalf("List() error: %v", err)
	}
	for _, f := range felts {
		if f.ID == "venue" {
			t.Fatal("expected the malformed fiber to be absent from List()")
		}
	}

	output, err := runCommand(t, dir, "check")
	if err == nil {
		t.Fatalf("felt check succeeded despite an unparseable fiber:\n%s", output)
	}
	if !strings.Contains(err.Error(), "2 error(s)") {
		t.Fatalf("unparseable fiber not counted as an error: %v\n%s", err, output)
	}

	unparseable := strings.Index(output, "unparseable")
	if unparseable < 0 {
		t.Fatalf("check does not report the unparseable fiber:\n%s", output)
	}
	// The walk resolves symlinks (macOS /var → /private/var).
	resolvedPath, err := filepath.EvalSymlinks(brokenPath)
	if err != nil {
		t.Fatalf("EvalSymlinks: %v", err)
	}
	if !strings.Contains(output, resolvedPath) {
		t.Fatalf("check does not name the unparseable fiber's path:\n%s", output)
	}
	if !strings.Contains(output, "mapping values are not allowed") {
		t.Fatalf("check does not carry the parse error:\n%s", output)
	}
	if broken := strings.Index(output, "broken body reference"); broken < 0 || broken < unparseable {
		t.Fatalf("unparseable fiber must be reported before cosmetic issues:\n%s", output)
	}
}

// TestCheckCommandStaleLinkPathWarnsWithoutFailing: a link whose path only a
// slug rescue could salvage is a warning — it still reaches its fiber — so
// check prints it and exits zero.
func TestCheckCommandStaleLinkPathWarnsWithoutFailing(t *testing.T) {
	dir, storage := newStore(t)
	created := mustParseTime(t, "2026-04-10T09:00:00Z")
	for _, f := range []*felt.Felt{
		{ID: "proj", Name: "Proj", CreatedAt: created},
		{ID: "proj/jackknife", Name: "Jackknife", CreatedAt: created},
		{ID: "citer", Name: "Citer", CreatedAt: created, Body: "See [[old-home/jackknife]]."},
	} {
		if err := storage.Write(f); err != nil {
			t.Fatalf("Write(%s): %v", f.ID, err)
		}
	}

	output, err := runCommand(t, dir, "check")
	if err != nil {
		t.Fatalf("felt check failed on a warning alone: %v\n%s", err, output)
	}
	want := `WARNING: citer body: stale path in reference "old-home/jackknife": no fiber lives there; it resolves to proj/jackknife only by its final segment`
	if !strings.Contains(output, want) {
		t.Fatalf("missing stale-path warning:\n%s", output)
	}
}

// TestCheckCommandFailsOnStrayFiberFile: the repro that motivated stray
// detection — a bare leaf beside its parent's file and a link to it. The
// stray is a layout error pointing at migrate, and the link is broken because
// the stray is not a fiber.
func TestCheckCommandFailsOnStrayFiberFile(t *testing.T) {
	dir, storage := newStore(t)
	created := mustParseTime(t, "2026-04-10T09:00:00Z")
	for _, f := range []*felt.Felt{
		{ID: "parent", Name: "Parent", CreatedAt: created},
		{ID: "linker", Name: "Linker", CreatedAt: created, Body: "[[parent/leaf]]"},
	} {
		if err := storage.Write(f); err != nil {
			t.Fatalf("Write(%s): %v", f.ID, err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, ".felt", "parent", "leaf.md"), []byte("---\nname: leaf\ntags: [x]\n---\n"), 0644); err != nil {
		t.Fatalf("write stray: %v", err)
	}

	output, err := runCommand(t, dir, "check")
	if err == nil {
		t.Fatalf("felt check succeeded with a stray fiber file:\n%s", output)
	}
	for _, want := range []string{
		"ERROR: parent/leaf: bare fiber file .felt/parent/leaf.md is outside the directory layout",
		".felt/parent/leaf/leaf.md — " + felt.LegacyFlatMigrationHint,
		`ERROR: linker body: broken body reference "parent/leaf"`,
	} {
		if !strings.Contains(output, want) {
			t.Fatalf("missing %q in:\n%s", want, output)
		}
	}
}

// TestCommandsRefuseStrayIDs: a command naming a stray fiber file's id refuses
// with the way out instead of acting on a same-named fiber elsewhere, and
// `add` refuses to create the collision.
func TestCommandsRefuseStrayIDs(t *testing.T) {
	dir, storage := newStore(t)
	created := mustParseTime(t, "2026-04-10T09:00:00Z")
	for _, f := range []*felt.Felt{
		{ID: "proj", Name: "Proj", CreatedAt: created},
		{ID: "proj/a", Name: "A", CreatedAt: created},
		{ID: "proj/a/citer", Name: "Citer", CreatedAt: created},
		{ID: "x", Name: "X", CreatedAt: created},
		{ID: "x/leaf2", Name: "Twin", Status: felt.StatusOpen, CreatedAt: created},
	} {
		if err := storage.Write(f); err != nil {
			t.Fatalf("Write(%s): %v", f.ID, err)
		}
	}
	for _, slug := range []string{"leaf2", "leaf3"} {
		content := "---\nname: " + slug + "\nstatus: open\n---\n"
		if err := os.WriteFile(filepath.Join(dir, ".felt", "proj", "a", slug+".md"), []byte(content), 0644); err != nil {
			t.Fatalf("write stray: %v", err)
		}
	}

	for _, args := range [][]string{
		{"show", "proj/a/leaf2"},
		{"edit", "proj/a/leaf2", "--status", "closed"},
		{"rm", "proj/a/leaf2"},
		{"nest", "proj/a/leaf2", "proj"},
		{"add", "proj/a/leaf3", "Leaf three"},
	} {
		output, err := runCommand(t, dir, args...)
		if err == nil {
			t.Errorf("felt %v succeeded:\n%s", args, output)
			continue
		}
		if !strings.Contains(err.Error(), ".md holds fiber frontmatter but is outside the directory layout") &&
			!strings.Contains(err.Error(), "would collide with a stray fiber file") {
			t.Errorf("felt %v error = %v, want a stray refusal", args, err)
		}
	}
	twin := mustRead(t, storage, "x/leaf2")
	if twin.Status != felt.StatusOpen {
		t.Fatalf("the slug twin was touched: %+v", twin)
	}
	if _, err := os.Stat(filepath.Join(dir, ".felt", "proj", "a", "leaf3", "leaf3.md")); !os.IsNotExist(err) {
		t.Fatalf("add created a fiber over the stray: %v", err)
	}
}
