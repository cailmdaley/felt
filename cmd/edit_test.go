package cmd

import (
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

func saveEditGlobals() func() {
	prev := struct {
		name    string
		status  string
		due     string
		tags    []string
		untag   []string
		body    string
		outcome string
	}{
		editName, editStatus, editDue, editTags, editUntag, editBody, editOutcome,
	}

	editName = ""
	editStatus = ""
	editDue = ""
	editTags = nil
	editUntag = nil
	editBody = ""
	editOutcome = ""

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
	}
}
