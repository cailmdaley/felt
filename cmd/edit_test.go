package cmd

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestEditMetadataFlags(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	if err := storage.Write(&felt.Felt{
		ID:        "fiber-a",
		Name:      "Fiber A",
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
	}); err != nil {
		t.Fatalf("Write: %v", err)
	}

	reset := saveEditGlobals()
	defer reset()

	out, err := runCommand(t, dir, "edit", "fiber-a",
		"--name", "Renamed",
		"--status", "active",
		"--tag", "alpha,beta",
		"--outcome", "Landed.",
	)
	if err != nil {
		t.Fatalf("edit metadata: %v\n%s", err, out)
	}

	f, err := storage.Read("fiber-a")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if f.Name != "Renamed" {
		t.Fatalf("Name = %q, want %q", f.Name, "Renamed")
	}
	if f.Status != felt.StatusActive {
		t.Fatalf("Status = %q, want %q", f.Status, felt.StatusActive)
	}
	if !f.HasTag("alpha") || !f.HasTag("beta") {
		t.Fatalf("Tags = %v, want alpha+beta", f.Tags)
	}
	if f.Outcome != "Landed." {
		t.Fatalf("Outcome = %q, want %q", f.Outcome, "Landed.")
	}
}

func TestEditBodyOverwriteDetection(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	if err := storage.Write(&felt.Felt{
		ID:        "fiber-a",
		Name:      "Fiber A",
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
		Body:      "original body",
	}); err != nil {
		t.Fatalf("Write: %v", err)
	}

	reset := saveEditGlobals()
	defer reset()

	out, err := runCommand(t, dir, "edit", "fiber-a", "--body", "replacement body")
	if err != nil {
		t.Fatalf("edit body: %v\n%s", err, out)
	}
	if out != "Updated fiber-a (body overwritten)\n" {
		t.Fatalf("unexpected output: %q", out)
	}
}

// TestEditSetUnsetExtraScalars covers the generic opaque-scalar writer that the
// cross-host kanban horizon path shells: --set is YAML-typed (so cold=true is a
// real boolean in the JSON Portolan reads), --unset removes, and a full
// horizon round-trip set→unset leaves the frontmatter clean.
func TestEditSetUnsetExtraScalars(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	if err := storage.Write(&felt.Felt{
		ID:        "fiber-a",
		Name:      "Fiber A",
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
	}); err != nil {
		t.Fatalf("Write: %v", err)
	}

	reset := saveEditGlobals()
	defer reset()

	if out, err := runCommand(t, dir, "edit", "fiber-a",
		"--set", "horizon=stashed",
		"--set", "cold=true",
	); err != nil {
		t.Fatalf("edit --set: %v\n%s", err, out)
	}

	f, err := storage.Read("fiber-a")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	// Type fidelity is the contract: Portolan reads `typeof cold === 'boolean'`.
	encoded, err := json.Marshal(f)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if !strings.Contains(string(encoded), `"cold":true`) {
		t.Fatalf("cold did not round-trip as a JSON boolean: %s", encoded)
	}
	if !strings.Contains(string(encoded), `"horizon":"stashed"`) {
		t.Fatalf("horizon did not round-trip as a JSON string: %s", encoded)
	}
	if node := f.ExtraFields["cold"]; node == nil || node.Tag != "!!bool" {
		t.Fatalf("cold node tag = %v, want !!bool", node)
	}

	// Unsetting both keys returns the frontmatter to clean. saveEditGlobals
	// re-zeroes the flag globals and ResetFlags() clears cobra's accumulated
	// StringArray state between Execute() calls; the outer defer still restores
	// the originals.
	saveEditGlobals()
	if out, err := runCommand(t, dir, "edit", "fiber-a",
		"--unset", "horizon",
		"--unset", "cold",
	); err != nil {
		t.Fatalf("edit --unset: %v\n%s", err, out)
	}
	f, err = storage.Read("fiber-a")
	if err != nil {
		t.Fatalf("Read after unset: %v", err)
	}
	if _, ok := f.ExtraFields["horizon"]; ok {
		t.Fatalf("horizon survived --unset: %v", f.ExtraFields)
	}
	if _, ok := f.ExtraFields["cold"]; ok {
		t.Fatalf("cold survived --unset: %v", f.ExtraFields)
	}
}

// TestEditSetUnsetGuards covers the fail-loud rails: native keys are refused on
// both verbs, malformed --set is rejected, and --set will not scalar-clobber a
// structured value (the shuttle: block).
func TestEditSetUnsetGuards(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	f := &felt.Felt{
		ID:        "fiber-a",
		Name:      "Fiber A",
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
	}
	// Seed a structured extra field (a mapping) to exercise the clobber guard.
	if err := f.SetExtraField("shuttle", map[string]any{"kind": "oneshot", "agent": "claude-opus"}); err != nil {
		t.Fatalf("SetExtraField shuttle: %v", err)
	}
	if err := storage.Write(f); err != nil {
		t.Fatalf("Write: %v", err)
	}

	cases := []struct {
		name string
		args []string
		want string
	}{
		{"set native key", []string{"--set", "status=active"}, "native field"},
		{"unset native key", []string{"--unset", "outcome"}, "native field"},
		{"set without equals", []string{"--set", "horizon"}, "expected key=value"},
		{"set empty value", []string{"--set", "horizon="}, "empty value"},
		{"set clobbers structured", []string{"--set", "shuttle=oops"}, "structured value"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reset := saveEditGlobals()
			defer reset()
			out, err := runCommand(t, dir, append([]string{"edit", "fiber-a"}, tc.args...)...)
			if err == nil {
				t.Fatalf("expected error, got success: %s", out)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not mention %q", err.Error(), tc.want)
			}
		})
	}
}

func saveEditGlobals() func() {
	prev := struct {
		name    string
		status  string
		due     string
		tags    []string
		untag   []string
		body    string
		outcome string
		set     []string
		unset   []string
	}{
		editName, editStatus, editDue, editTags, editUntag, editBody, editOutcome, editSet, editUnset,
	}

	editName = ""
	editStatus = ""
	editDue = ""
	editTags = nil
	editUntag = nil
	editBody = ""
	editOutcome = ""
	editSet = nil
	editUnset = nil

	editCmd.ResetFlags()
	initEditFlags()

	return func() {
		editName = prev.name
		editStatus = prev.status
		editDue = prev.due
		editTags = prev.tags
		editUntag = prev.untag
		editBody = prev.body
		editOutcome = prev.outcome
		editSet = prev.set
		editUnset = prev.unset
	}
}
