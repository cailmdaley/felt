package cmd

import (
	"os"
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

func TestLsBodySearchScansMarkdownWithoutCreatingIndex(t *testing.T) {
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
	if _, err := os.Stat(dir + "/.felt/index.db"); !os.IsNotExist(err) {
		t.Fatalf("ls --body should not create index.db, stat err = %v", err)
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
	prevJSON := jsonOutput

	lsStatus = ""
	lsTags = nil
	lsRecent = 0
	lsBody = false
	lsExact = false
	lsRegex = false
	lsHasFields = nil
	lsJSONFields = nil
	jsonOutput = false

	// Reset cobra's per-flag Changed bookkeeping. Without this, a prior test
	// that passed e.g. `-s active` leaves Changed("status") == true, and
	// subsequent tests inspecting `cmd.Flags().Changed("status")` see stale
	// state even though the underlying string variable was reset above.
	for _, name := range []string{"status", "tag", "recent", "body", "exact", "regex", "has-field", "json-field", "json"} {
		if f := lsCmd.Flags().Lookup(name); f != nil {
			f.Changed = false
		}
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
		jsonOutput = prevJSON
	}
}
