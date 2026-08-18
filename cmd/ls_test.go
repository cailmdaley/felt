package cmd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestTreeDisplayID(t *testing.T) {
	tests := []struct {
		name string
		id   string
		want string
	}{
		{
			name: "short id unchanged",
			id:   "science/cmbx",
			want: "science/cmbx",
		},
		{
			name: "deep id with short leaf shows leaf",
			id:   "ai-futures/application/interview",
			want: ".../interview",
		},
		{
			name: "deep id with long leaf keeps full leaf",
			id:   "ai-futures/application/cnrs-ai-rising-talents-interview-prep",
			want: ".../cnrs-ai-rising-talents-interview-prep",
		},
		{
			name: "long top-level id unchanged",
			id:   "anthropic-stem-fellowship",
			want: "anthropic-stem-fellowship",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := treeDisplayID(tt.id); got != tt.want {
				t.Fatalf("treeDisplayID(%q) = %q, want %q", tt.id, got, tt.want)
			}
		})
	}
}

// Listing endpoints must always emit `[]` (not `null`) when no fibers match.
// Consumers like the SessionStart hook pipe the JSON straight into `jq '.[]'`,
// which errors out on null — a single user with no active fibers shouldn't
// have to handle two distinct empty shapes.
func TestLsJSONEmptyEmitsArrayNotNull(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	reset := saveLsGlobals()
	defer reset()

	for _, args := range [][]string{
		{"ls", "-j"},
		{"ls", "-j", "-s", "active"},
		{"ls", "-j", "-s", "all"},
	} {
		out, err := runCommand(t, dir, args...)
		if err != nil {
			t.Fatalf("%v: %v\n%s", args, err, out)
		}
		got := strings.TrimSpace(out)
		if got != "[]" {
			t.Fatalf("%v: got %q, want %q", args, got, "[]")
		}
	}
}

func TestLsBodySearchScansMarkdown(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	for _, fiber := range []*felt.Felt{
		{ID: "project/question", Name: "Question", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"), Body: "nothing special"},
		{ID: "project/analysis", Name: "Analysis", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"), Body: "The body-only needle lives here."},
	} {
		if err := storage.Write(fiber); err != nil {
			t.Fatalf("Write(%s) error: %v", fiber.ID, err)
		}
	}

	reset := saveLsGlobals()
	defer reset()

	out, err := runCommand(t, dir, "ls", "--body", "body-only needle")
	if err != nil {
		t.Fatalf("ls --body: %v\n%s", err, out)
	}
	if !strings.Contains(out, "project/analysis") {
		t.Fatalf("ls --body missing body match:\n%s", out)
	}
	if strings.Contains(out, "project/question") {
		t.Fatalf("ls --body included non-match:\n%s", out)
	}
}

// A fiber directory with a report.html sibling surfaces report_path (absolute,
// pointing at that sibling); a fiber without one omits/empties the field. Both
// the plain walk and the --json-field projection must agree.
func TestLsJSONReportPath(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	for _, fiber := range []*felt.Felt{
		{ID: "project/reported", Name: "Reported", Status: felt.StatusOpen, CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")},
		{ID: "project/plain", Name: "Plain", Status: felt.StatusOpen, CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")},
	} {
		if err := storage.Write(fiber); err != nil {
			t.Fatalf("Write(%s) error: %v", fiber.ID, err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, ".felt", "project", "reported", "report.html"), []byte("<html></html>"), 0644); err != nil {
		t.Fatalf("writing report.html: %v", err)
	}

	reset := saveLsGlobals()
	defer reset()

	out, err := runCommand(t, dir, "ls", "-j", "--json-field", "id,report_path")
	if err != nil {
		t.Fatalf("ls -j --json-field id,report_path: %v\n%s", err, out)
	}

	var rows []map[string]any
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		t.Fatalf("unmarshal: %v\n%s", err, out)
	}

	byID := make(map[string]map[string]any, len(rows))
	for _, row := range rows {
		byID[row["id"].(string)] = row
	}

	reported, ok := byID["project/reported"]
	if !ok {
		t.Fatalf("missing project/reported in %v", rows)
	}
	wantSuffix := filepath.Join("project", "reported", "report.html")
	gotPath, _ := reported["report_path"].(string)
	if !strings.HasSuffix(gotPath, wantSuffix) {
		t.Fatalf("report_path = %q, want suffix %q", gotPath, wantSuffix)
	}

	plain, ok := byID["project/plain"]
	if !ok {
		t.Fatalf("missing project/plain in %v", rows)
	}
	if _, present := plain["report_path"]; present {
		t.Fatalf("project/plain unexpectedly has report_path: %v", plain)
	}

	// --json-field is a repeatable pflag StringArrayVar: it appends across
	// Execute() calls rather than resetting, so the prior --json-field value
	// would otherwise leak into this second, unprojected call.
	lsJSONFields = nil
	if f := lsCmd.Flags().Lookup("json-field"); f != nil {
		f.Changed = false
	}

	// Full --json output (no field projection) carries the same contract.
	out, err = runCommand(t, dir, "ls", "-j")
	if err != nil {
		t.Fatalf("ls -j: %v\n%s", err, out)
	}
	if !strings.Contains(out, `"report_path"`) {
		t.Fatalf("full --json output missing report_path key:\n%s", out)
	}
}

// A query naming a directory fiber matches its whole subtree by slug. The
// ancestor stands in for its descendants with a count; -v restores the flat
// listing; --json stays uncollapsed for the daemon and hook consumers.
func TestLsCollapsesMatchesUnderMatchingAncestor(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	created := mustParseTime(t, "2026-04-10T09:00:00Z")
	for _, fiber := range []*felt.Felt{
		{ID: "portolan/swarm", Name: "Swarm", CreatedAt: created},
		{ID: "portolan/swarm/hex-grid", Name: "Hex grid", CreatedAt: created},
		{ID: "portolan/swarm/hex-grid/tiling", Name: "Tiling", CreatedAt: created},
		{ID: "elsewhere/swarm-notes", Name: "Swarm notes", CreatedAt: created},
	} {
		if err := storage.Write(fiber); err != nil {
			t.Fatalf("Write(%s) error: %v", fiber.ID, err)
		}
	}

	reset := saveLsGlobals()
	defer reset()

	out, err := runCommand(t, dir, "ls", "swarm")
	if err != nil {
		t.Fatalf("ls swarm: %v\n%s", err, out)
	}
	if strings.Contains(out, "hex-grid") {
		t.Fatalf("descendants not collapsed:\n%s", out)
	}
	if !strings.Contains(out, "(+2 matching descendants; -v to expand)") {
		t.Fatalf("missing collapse annotation:\n%s", out)
	}
	// A match whose ancestors don't match is listed as before.
	if !strings.Contains(out, "elsewhere/swarm-notes") {
		t.Fatalf("unrelated match dropped:\n%s", out)
	}

	// Re-arm: cobra's per-flag Changed state must not leak between invocations.
	saveLsGlobals()

	out, err = runCommand(t, dir, "ls", "-v", "swarm")
	if err != nil {
		t.Fatalf("ls -v swarm: %v\n%s", err, out)
	}
	for _, want := range []string{"portolan/swarm", "portolan/swarm/hex-grid", "portolan/swarm/hex-grid/tiling", "elsewhere/swarm-notes"} {
		if !strings.Contains(out, want) {
			t.Fatalf("-v dropped %s:\n%s", want, out)
		}
	}
	if strings.Contains(out, "matching descendants") {
		t.Fatalf("-v should not annotate:\n%s", out)
	}

	saveLsGlobals()

	out, err = runCommand(t, dir, "ls", "-j", "swarm")
	if err != nil {
		t.Fatalf("ls -j swarm: %v\n%s", err, out)
	}
	var rows []map[string]any
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		t.Fatalf("unmarshal: %v\n%s", err, out)
	}
	if len(rows) != 4 {
		t.Fatalf("--json collapsed results: got %d rows, want 4\n%s", len(rows), out)
	}
}

// An exact match is the likeliest target of the query, so it survives collapse
// even when an ancestor also matches.
func TestLsCollapseKeepsExactMatch(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	created := mustParseTime(t, "2026-04-10T09:00:00Z")
	for _, fiber := range []*felt.Felt{
		{ID: "swarm-tools", Name: "Swarm tools", CreatedAt: created},
		{ID: "swarm-tools/swarm", Name: "Swarm", CreatedAt: created},
	} {
		if err := storage.Write(fiber); err != nil {
			t.Fatalf("Write(%s) error: %v", fiber.ID, err)
		}
	}

	reset := saveLsGlobals()
	defer reset()

	out, err := runCommand(t, dir, "ls", "swarm")
	if err != nil {
		t.Fatalf("ls swarm: %v\n%s", err, out)
	}
	if !strings.Contains(out, "swarm-tools/swarm") {
		t.Fatalf("exact match suppressed by collapse:\n%s", out)
	}
	if strings.Contains(out, "matching descendant") {
		t.Fatalf("exact match should not be counted as collapsed:\n%s", out)
	}
}

// A search widens past open+active so untracked fibers can match, but closed
// matches are counted rather than printed — a store holds far more finished
// work than live work.
func TestLsQueryHidesClosedBehindHint(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	created := mustParseTime(t, "2026-04-10T09:00:00Z")
	closedAt := mustParseTime(t, "2026-04-11T09:00:00Z")
	for _, fiber := range []*felt.Felt{
		{ID: "shear-live", Name: "Shear live", Status: felt.StatusOpen, CreatedAt: created},
		{ID: "shear-untracked", Name: "Shear untracked", CreatedAt: created},
		{ID: "shear-done", Name: "Shear done", Status: felt.StatusClosed, CreatedAt: created, ClosedAt: &closedAt},
		{ID: "shear-also-done", Name: "Shear also done", Status: felt.StatusClosed, CreatedAt: created, ClosedAt: &closedAt},
	} {
		if err := storage.Write(fiber); err != nil {
			t.Fatalf("Write(%s) error: %v", fiber.ID, err)
		}
	}

	reset := saveLsGlobals()
	defer reset()

	out, err := runCommand(t, dir, "ls", "shear")
	if err != nil {
		t.Fatalf("ls shear: %v\n%s", err, out)
	}
	// Untracked fibers still match — the widening that a filter triggers is
	// unchanged apart from closed.
	for _, want := range []string{"shear-live", "shear-untracked"} {
		if !strings.Contains(out, want) {
			t.Fatalf("ls shear dropped %s:\n%s", want, out)
		}
	}
	if strings.Contains(out, "shear-done") || strings.Contains(out, "shear-also-done") {
		t.Fatalf("closed matches printed:\n%s", out)
	}
	if !strings.Contains(out, "(+2 closed — add -s closed)") {
		t.Fatalf("missing closed hint:\n%s", out)
	}

	// Re-arm: cobra's per-flag Changed state must not leak between invocations.
	saveLsGlobals()

	out, err = runCommand(t, dir, "ls", "-s", "closed", "shear")
	if err != nil {
		t.Fatalf("ls -s closed shear: %v\n%s", err, out)
	}
	if !strings.Contains(out, "shear-done") {
		t.Fatalf("-s closed did not restore closed matches:\n%s", out)
	}
	if strings.Contains(out, "add -s closed") {
		t.Fatalf("explicit -s should not print the hint:\n%s", out)
	}

	saveLsGlobals()

	out, err = runCommand(t, dir, "ls", "-s", "all", "shear")
	if err != nil {
		t.Fatalf("ls -s all shear: %v\n%s", err, out)
	}
	for _, want := range []string{"shear-live", "shear-untracked", "shear-done", "shear-also-done"} {
		if !strings.Contains(out, want) {
			t.Fatalf("-s all dropped %s:\n%s", want, out)
		}
	}

	// -n ranks by closed-at: it exists to surface recently finished work, so it
	// keeps the old all-statuses behavior.
	saveLsGlobals()

	out, err = runCommand(t, dir, "ls", "-n", "10")
	if err != nil {
		t.Fatalf("ls -n 10: %v\n%s", err, out)
	}
	if !strings.Contains(out, "shear-done") {
		t.Fatalf("-n suppressed closed:\n%s", out)
	}

	// --json is the wire the daemon poll, the hook, and the board read: it must
	// still carry every status the filter widened to.
	saveLsGlobals()

	out, err = runCommand(t, dir, "ls", "-j", "shear")
	if err != nil {
		t.Fatalf("ls -j shear: %v\n%s", err, out)
	}
	var rows []map[string]any
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		t.Fatalf("unmarshal: %v\n%s", err, out)
	}
	if len(rows) != 4 {
		t.Fatalf("--json dropped closed rows: got %d, want 4\n%s", len(rows), out)
	}
}

// Closed suppression runs before the containment collapse, so a collapsed
// ancestor's count describes lines that would actually have printed.
func TestLsCollapseCountExcludesSuppressedClosed(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	created := mustParseTime(t, "2026-04-10T09:00:00Z")
	closedAt := mustParseTime(t, "2026-04-11T09:00:00Z")
	for _, fiber := range []*felt.Felt{
		{ID: "portolan/swarm", Name: "Swarm", Status: felt.StatusOpen, CreatedAt: created},
		{ID: "portolan/swarm/hex-grid", Name: "Hex grid", Status: felt.StatusOpen, CreatedAt: created},
		{ID: "portolan/swarm/tiling", Name: "Tiling", Status: felt.StatusClosed, CreatedAt: created, ClosedAt: &closedAt},
	} {
		if err := storage.Write(fiber); err != nil {
			t.Fatalf("Write(%s) error: %v", fiber.ID, err)
		}
	}

	reset := saveLsGlobals()
	defer reset()

	out, err := runCommand(t, dir, "ls", "swarm")
	if err != nil {
		t.Fatalf("ls swarm: %v\n%s", err, out)
	}
	if !strings.Contains(out, "(+1 matching descendant; -v to expand)") {
		t.Fatalf("collapse count should exclude the suppressed closed descendant:\n%s", out)
	}
	if !strings.Contains(out, "(+1 closed — add -s closed)") {
		t.Fatalf("missing closed hint:\n%s", out)
	}
}

func TestTreeDepthLimit(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}
	created := mustParseTime(t, "2026-04-10T09:00:00Z")
	for _, fiber := range []*felt.Felt{
		{ID: "project", Name: "Project", CreatedAt: created},
		{ID: "project/alpha", Name: "Alpha", CreatedAt: created},
		{ID: "project/alpha/deep", Name: "Deep", CreatedAt: created},
		{ID: "project/alpha/deep/deeper", Name: "Deeper", CreatedAt: created},
	} {
		if err := storage.Write(fiber); err != nil {
			t.Fatalf("Write(%s) error: %v", fiber.ID, err)
		}
	}

	reset := saveLsGlobals()
	defer reset()

	out, err := runCommand(t, dir, "tree", "-L", "1")
	if err != nil {
		t.Fatalf("tree -L 1: %v\n%s", err, out)
	}
	if !strings.Contains(out, "alpha") {
		t.Fatalf("tree -L 1 dropped direct child:\n%s", out)
	}
	if strings.Contains(out, "deeper") {
		t.Fatalf("tree -L 1 showed depth 2:\n%s", out)
	}
	if !strings.Contains(out, "… (2 more below)") {
		t.Fatalf("missing elision indicator:\n%s", out)
	}

	saveLsGlobals()

	full, err := runCommand(t, dir, "tree")
	if err != nil {
		t.Fatalf("tree: %v\n%s", err, full)
	}
	if !strings.Contains(full, "deeper") {
		t.Fatalf("unflagged tree truncated:\n%s", full)
	}
	if strings.Contains(full, "more below") {
		t.Fatalf("unflagged tree showed elision indicator:\n%s", full)
	}
}

func saveLsGlobals() func() {
	prevStatus := lsStatus
	prevTags := lsTags
	prevRecent := lsRecent
	prevBody := lsBody
	prevExact := lsExact
	prevRegex := lsRegex
	prevHasFields := lsHasFields
	prevJSONFields := lsJSONFields
	prevVerbose := lsVerbose
	prevLocal := lsLocal
	prevJSON := jsonOutput
	prevTreeDepth := treeDepth

	lsStatus = ""
	lsTags = nil
	lsRecent = 0
	lsBody = false
	lsExact = false
	lsRegex = false
	lsHasFields = nil
	lsJSONFields = nil
	lsVerbose = false
	lsLocal = false
	jsonOutput = false
	treeDepth = 0

	// Reset cobra's per-flag Changed bookkeeping. Without this, a prior test
	// that passed e.g. `-s active` leaves Changed("status") == true, and
	// subsequent tests inspecting `cmd.Flags().Changed("status")` see stale
	// state even though the underlying string variable was reset above.
	for _, name := range []string{"status", "tag", "recent", "body", "exact", "regex", "has-field", "json-field", "json", "verbose", "local"} {
		if f := lsCmd.Flags().Lookup(name); f != nil {
			f.Changed = false
		}
	}
	if f := treeCmd.Flags().Lookup("depth"); f != nil {
		f.Changed = false
	}

	return func() {
		lsStatus = prevStatus
		lsTags = prevTags
		lsRecent = prevRecent
		lsBody = prevBody
		lsExact = prevExact
		lsRegex = prevRegex
		lsHasFields = prevHasFields
		lsJSONFields = prevJSONFields
		lsVerbose = prevVerbose
		lsLocal = prevLocal
		jsonOutput = prevJSON
		treeDepth = prevTreeDepth
	}
}
