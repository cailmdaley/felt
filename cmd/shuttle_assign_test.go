package cmd

import (
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

const assignTestUID = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
const assignTestRoleUID = "01BX5ZZKBKACTAV9WEVGEMMVRZ"
const assignTestOtherUID = "01D7QH6R8X9M2Q8D6Y0D5Q4C1A"

func resetAssignFlags() {
	assignCollaborators = nil
	assignRoles = nil
	assignClear = false
	assignJSON = ""
	assignCmd.ResetFlags()
	assignCmd.Flags().StringArrayVar(&assignRoles, "role", nil, "Role")
	assignCmd.Flags().StringArrayVar(&assignCollaborators, "collaborator", nil, "Collaborator")
	assignCmd.Flags().BoolVar(&assignClear, "clear", false, "Clear")
	assignCmd.Flags().StringVar(&assignJSON, "json-assignment", "", "Replace")
}

func decodeAssignment(t *testing.T, storage *felt.Storage) map[string][]string {
	t.Helper()
	var assignment map[string][]string
	if err := mustRead(t, storage, "work").ExtraFields[collaborationField].Decode(&assignment); err != nil {
		t.Fatal(err)
	}
	return assignment
}

func TestShuttleAssign_WritesReadableMultiRoleRosterAndAddsMembership(t *testing.T) {
	defer resetAssignFlags()
	dir, storage := newStore(t)
	seedFiber(t, storage, "roles/vizier", assignTestRoleUID, "", nil, nil)
	seedFiber(t, storage, "roles/vizier/fable", assignTestUID, "", nil, nil)
	seedFiber(t, storage, "roles/vizier/astra", "01C7QH6R8X9M2Q8D6Y0D5Q4C1A", "", nil, nil)
	seedFiber(t, storage, "roles/organizer", assignTestOtherUID, "", nil, nil)
	seedFiber(t, storage, "roles/organizer/opus", "01C7QH6R8X9M2Q8D6Y0D5Q4C1B", "", nil, nil)
	seedFiber(t, storage, "work", "", felt.StatusActive, map[string]any{"kind": "oneshot"}, nil)

	out, err := runCommand(t, dir, "shuttle", "assign", "work",
		"--role", "vizier", "--collaborator", "fable", "--collaborator", "astra",
		"--role", "organizer", "--collaborator", "roles/organizer/opus")
	if err != nil {
		t.Fatalf("assign: %v\n%s", err, out)
	}
	got := decodeAssignment(t, storage)
	if len(got) != 2 || strings.Join(got["vizier"], ",") != "fable,astra" || strings.Join(got["organizer"], ",") != "opus" {
		t.Fatalf("assignment = %#v", got)
	}
	if mustRead(t, storage, "work").Status != felt.StatusActive {
		t.Fatal("assignment changed lifecycle status")
	}

	resetAssignFlags()
	if _, err := runCommand(t, dir, "shuttle", "assign", "work", "--role", "research"); err == nil {
		t.Fatal("assignment accepted nonexistent role")
	}
	resetAssignFlags()
	if _, err := runCommand(t, dir, "shuttle", "assign", "work", "--role", "vizier", "--collaborator", "astra"); err != nil {
		t.Fatalf("idempotent patch: %v", err)
	}
	got = decodeAssignment(t, storage)
	if len(got["vizier"]) != 2 || len(got["organizer"]) != 1 {
		t.Fatalf("patch replaced existing membership: %#v", got)
	}
}

func TestShuttleAssign_RoleOnlyAndJSONReplacement(t *testing.T) {
	defer resetAssignFlags()
	dir, storage := newStore(t)
	seedFiber(t, storage, "roles/role", assignTestRoleUID, "", nil, nil)
	seedFiber(t, storage, "roles/collaborator", assignTestOtherUID, "", nil, nil)
	seedFiber(t, storage, "work", "", "", nil, nil)
	if _, err := runCommand(t, dir, "shuttle", "assign", "work", "--role", "role"); err != nil {
		t.Fatalf("role-only assign: %v", err)
	}
	if got := decodeAssignment(t, storage); len(got) != 1 || got["role"] == nil || len(got["role"]) != 0 {
		t.Fatalf("role-only assignment = %#v", got)
	}

	resetAssignFlags()
	// These valid role slugs also name fields used by the legacy representation.
	json := `{"role":[],"collaborator":[]}`
	if _, err := runCommand(t, dir, "shuttle", "assign", "work", "--json-assignment", json); err != nil {
		t.Fatalf("JSON replacement: %v", err)
	}
	if got := decodeAssignment(t, storage); len(got) != 2 || got["role"] == nil || got["collaborator"] == nil {
		t.Fatalf("JSON roster = %#v", got)
	}

	resetAssignFlags()
	if _, err := runCommand(t, dir, "shuttle", "assign", "work", "--clear"); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if _, ok := mustRead(t, storage, "work").ExtraFields[collaborationField]; ok {
		t.Fatal("--clear retained collaboration")
	}
}

func TestShuttleAssign_RejectsAmbiguousUIDAndNestedNotesIdentity(t *testing.T) {
	defer resetAssignFlags()
	dir, storage := newStore(t)
	seedFiber(t, storage, "roles/vizier", assignTestRoleUID, "", nil, nil)
	seedFiber(t, storage, "roles/other", assignTestOtherUID, "", nil, nil)
	seedFiber(t, storage, "roles/vizier/fable", assignTestUID, "", nil, nil)
	seedFiber(t, storage, "roles/other/fable", "01C7QH6R8X9M2Q8D6Y0D5Q4C1A", "", nil, nil)
	seedFiber(t, storage, "roles/vizier/fable/notes", "01C7QH6R8X9M2Q8D6Y0D5Q4C1B", "", nil, nil)
	seedFiber(t, storage, "work", "", "", nil, nil)
	for _, flags := range [][]string{
		{"--collaborator", "fable"},
		{"--collaborator", "roles/vizier/fable/notes"},
		{"--collaborator", "outside/fable"},
		{"--role", "vizier", "--collaborator", "01C7QH6R8X9M2Q8D6Y0D5Q4C1B"},
	} {
		resetAssignFlags()
		args := append([]string{"shuttle", "assign", "work"}, flags...)
		if out, err := runCommand(t, dir, args...); err == nil {
			t.Fatalf("assign %v unexpectedly succeeded: %s", flags, out)
		}
	}
}

func TestShuttleAssign_JSONValidatesCanonicalSlugPaths(t *testing.T) {
	defer resetAssignFlags()
	dir, storage := newStore(t)
	seedFiber(t, storage, "roles/vizier", assignTestRoleUID, "", nil, nil)
	seedFiber(t, storage, "roles/vizier/fable-alias", assignTestUID, "", nil, nil)
	roleAlias := mustRead(t, storage, "roles/vizier/fable-alias")
	roleAlias.Name = "fable"
	if err := storage.Write(roleAlias); err != nil {
		t.Fatal(err)
	}
	seedFiber(t, storage, "work", "", "", nil, nil)
	if out, err := runCommand(t, dir, "shuttle", "assign", "work", "--json-assignment", `{"vizier":["fable"]}`); err == nil {
		t.Fatalf("JSON accepted a display-name alias as a slug path: %s", out)
	}
}

func TestShuttleAssign_ProjectViewUsesEnclosingRoleStore(t *testing.T) {
	defer resetAssignFlags()
	loom, project := newCrossStoreFixture(t)
	root := felt.NewStorage(loom)
	seedFiber(t, root, "roles/vizier", assignTestRoleUID, "", nil, nil)
	seedFiber(t, root, "roles/vizier/fable", assignTestUID, "", nil, nil)
	local := felt.NewStorage(project)
	seedFiber(t, local, "work", "", "", nil, nil)
	if out, err := runCommand(t, project, "shuttle", "assign", "work", "--role", "vizier", "--collaborator", "fable"); err != nil {
		t.Fatalf("assign through project view: %v\n%s", err, out)
	}
	if got := decodeAssignment(t, local); len(got) != 1 || got["vizier"][0] != "fable" {
		t.Fatalf("stored assignment = %#v", got)
	}
}

func TestShuttleAssign_EditingLegacyPairWritesReadableMapping(t *testing.T) {
	defer resetAssignFlags()
	dir, storage := newStore(t)
	seedFiber(t, storage, "roles/vizier", assignTestRoleUID, "", nil, nil)
	seedFiber(t, storage, "roles/vizier/fable", assignTestUID, "", nil, nil)
	seedFiber(t, storage, "roles/vizier/astra", "01C7QH6R8X9M2Q8D6Y0D5Q4C1A", "", nil, nil)
	seedFiber(t, storage, "work", "", "", nil, nil)
	work := mustRead(t, storage, "work")
	if err := work.SetExtraField(collaborationField, map[string]any{
		"role":         map[string]any{"uid": assignTestRoleUID},
		"collaborator": map[string]any{"uid": assignTestUID},
	}); err != nil {
		t.Fatal(err)
	}
	if err := storage.Write(work); err != nil {
		t.Fatal(err)
	}
	if _, err := runCommand(t, dir, "shuttle", "assign", "work", "--collaborator", "astra"); err != nil {
		t.Fatalf("patch legacy pair: %v", err)
	}
	if got := decodeAssignment(t, storage); strings.Join(got["vizier"], ",") != "fable,astra" {
		t.Fatalf("legacy assignment did not normalize on edit: %#v", got)
	}
}

func FuzzProfileQueryNeverEscapesRoles(f *testing.F) {
	for _, seed := range []string{"fable", "roles/vizier/fable", "roles/other/fable", "../fable", "roles/../secret", "", "\\roles\\vizier\\fable", assignTestUID} {
		f.Add(seed)
	}
	profiles := []*felt.Felt{
		{ID: "roles/vizier", UID: assignTestRoleUID, Name: "vizier"},
		{ID: "roles/vizier/fable", UID: assignTestUID, Name: "fable"},
		{ID: "roles/other", UID: assignTestOtherUID, Name: "other"},
		{ID: "roles/other/fable", UID: "01C7QH6R8X9M2Q8D6Y0D5Q4C1A", Name: "fable"},
		{ID: "roles/vizier/fable/notes", UID: "01C7QH6R8X9M2Q8D6Y0D5Q4C1B", Name: "notes"},
	}
	f.Fuzz(func(t *testing.T, query string) {
		got := matchCollaboratorProfiles(profiles, query, "roles/vizier")
		for _, profile := range got {
			if strings.Count(profile.ID, "/") != 2 || !strings.HasPrefix(profile.ID, "roles/vizier/") {
				t.Fatalf("query %q escaped direct role children: %q", query, profile.ID)
			}
		}
	})
}
