package cmd

import (
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

const assignTestUID = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
const assignTestRoleUID = "01BX5ZZKBKACTAV9WEVGEMMVRZ"

func resetAssignFlags() {
	assignCollaborator = ""
	assignCollaboratorOrigin = ""
	assignRole = ""
	assignRoleOrigin = ""
	assignClearCollaborator = false
	assignClearRole = false
	assignClear = false
	assignJSON = ""
	assignCmd.ResetFlags()
	assignCmd.Flags().StringVar(&assignCollaborator, "collaborator", "", "Collaborator profile intrinsic UID")
	assignCmd.Flags().StringVar(&assignCollaboratorOrigin, "collaborator-origin", "", "Owning host for --collaborator")
	assignCmd.Flags().StringVar(&assignRole, "role", "", "Role profile intrinsic UID")
	assignCmd.Flags().StringVar(&assignRoleOrigin, "role-origin", "", "Owning host for --role")
	assignCmd.Flags().BoolVar(&assignClearCollaborator, "clear-collaborator", false, "Remove the collaborator reference")
	assignCmd.Flags().BoolVar(&assignClearRole, "clear-role", false, "Remove the role reference")
	assignCmd.Flags().BoolVar(&assignClear, "clear", false, "Remove the whole collaboration assignment")
	assignCmd.Flags().StringVar(&assignJSON, "json-assignment", "", "Replace collaboration from one JSON object")
}

func TestShuttleAssign_StoresOpaqueAssignmentWithoutChangingLifecycle(t *testing.T) {
	defer resetAssignFlags()
	dir, storage := newStore(t)
	seedFiber(t, storage, "work", "", felt.StatusActive, map[string]any{"kind": "oneshot", "runtime": map[string]any{"session_uuid": "keep"}}, nil)

	out, err := runCommand(t, dir, "shuttle", "assign", "work",
		"--collaborator", assignTestUID, "--collaborator-origin", "hub",
		"--role", assignTestRoleUID, "--role-origin", "remote-1")
	if err != nil {
		t.Fatalf("assign: %v\n%s", err, out)
	}
	after := mustRead(t, storage, "work")
	if after.Status != felt.StatusActive {
		t.Fatalf("status changed to %q", after.Status)
	}
	if after.UpdatedAt == nil {
		t.Fatal("assignment did not touch durable recency")
	}
	var assignment map[string]any
	if err := after.ExtraFields[collaborationField].Decode(&assignment); err != nil {
		t.Fatal(err)
	}
	if assignment["collaborator"].(map[string]any)["uid"] != assignTestUID || assignment["role"].(map[string]any)["origin"] != "remote-1" {
		t.Fatalf("assignment = %#v", assignment)
	}
	if got := shuttleRuntimeMap(t, after)["session_uuid"]; got != "keep" {
		t.Fatalf("shuttle runtime was not preserved: %#v", got)
	}
}

func TestShuttleAssign_JSONReplacesAndPatchRefusesUnknownStoredFields(t *testing.T) {
	defer resetAssignFlags()
	dir, storage := newStore(t)
	seedFiber(t, storage, "work", "", "", nil, nil)
	json := `{"collaborator":{"uid":"` + assignTestUID + `","origin":"hub"},"role":{"uid":"` + assignTestRoleUID + `","origin":"remote"}}`
	if out, err := runCommand(t, dir, "shuttle", "assign", "work", "--json-assignment", json); err != nil {
		t.Fatalf("json assignment: %v\n%s", err, out)
	}

	f := mustRead(t, storage, "work")
	var raw map[string]any
	if err := f.ExtraFields[collaborationField].Decode(&raw); err != nil {
		t.Fatal(err)
	}
	raw["future"] = "kept"
	raw["role"].(map[string]any)["future_ref"] = true
	if err := f.SetExtraField(collaborationField, raw); err != nil {
		t.Fatal(err)
	}
	if err := storage.Write(f); err != nil {
		t.Fatal(err)
	}
	resetAssignFlags()
	_, err := runCommand(t, dir, "shuttle", "assign", "work", "--role", assignTestUID, "--role-origin", "next")
	if err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("patch with unknown stored fields error = %v", err)
	}
	f = mustRead(t, storage, "work")
	if err := f.ExtraFields[collaborationField].Decode(&raw); err != nil {
		t.Fatal(err)
	}
	if raw["future"] != "kept" || raw["role"].(map[string]any)["future_ref"] != true || raw["role"].(map[string]any)["origin"] != "remote" {
		t.Fatalf("refusal changed stored assignment: %#v", raw)
	}
}

func TestShuttleAssign_JSONUIDOnlyOmitsLegacyOrigin(t *testing.T) {
	defer resetAssignFlags()
	dir, storage := newStore(t)
	seedFiber(t, storage, "work", "", "", nil, nil)
	json := `{"role":{"uid":"` + assignTestRoleUID + `"}}`
	if out, err := runCommand(t, dir, "shuttle", "assign", "work", "--json-assignment", json); err != nil {
		t.Fatalf("json assignment: %v\n%s", err, out)
	}
	var assignment map[string]map[string]any
	if err := mustRead(t, storage, "work").ExtraFields[collaborationField].Decode(&assignment); err != nil {
		t.Fatal(err)
	}
	if got := assignment["role"]; len(got) != 1 || got["uid"] != assignTestRoleUID {
		t.Fatalf("stored role ref = %#v, want uid only", got)
	}
}

func TestShuttleAssign_ClearLastReferenceRemovesBlockAndRejectsConflicts(t *testing.T) {
	defer resetAssignFlags()
	dir, storage := newStore(t)
	seedFiber(t, storage, "work", "", "", nil, nil)
	if _, err := runCommand(t, dir, "shuttle", "assign", "work", "--role", assignTestRoleUID, "--role-origin", "hub"); err != nil {
		t.Fatalf("seed assignment: %v", err)
	}
	resetAssignFlags()
	if _, err := runCommand(t, dir, "shuttle", "assign", "work", "--clear-role"); err != nil {
		t.Fatalf("clear last reference: %v", err)
	}
	if _, ok := mustRead(t, storage, "work").ExtraFields[collaborationField]; ok {
		t.Fatal("clearing the last reference must remove collaboration block")
	}

	resetAssignFlags()
	_, err := runCommand(t, dir, "shuttle", "assign", "work", "--role", assignTestRoleUID, "--role-origin", "hub", "--clear-role")
	if err == nil || !strings.Contains(err.Error(), "conflicts") {
		t.Fatalf("set+clear same reference error = %v", err)
	}
}

func TestShuttleAssign_ProfileMoveDoesNotChangeUIDReference(t *testing.T) {
	defer resetAssignFlags()
	dir, storage := newStore(t)
	seedFiber(t, storage, "profiles/vizier", assignTestUID, "", nil, nil)
	seedFiber(t, storage, "work", "", "", nil, nil)
	if _, err := runCommand(t, dir, "shuttle", "assign", "work", "--collaborator", assignTestUID, "--collaborator-origin", "hub"); err != nil {
		t.Fatalf("assign: %v", err)
	}
	if err := storage.MoveSubtree("profiles/vizier", "collaborators/vizier"); err != nil {
		t.Fatalf("move profile: %v", err)
	}
	if _, err := storage.FindMetadataInScope("", assignTestUID); err != nil {
		t.Fatalf("moved profile no longer resolves by intrinsic UID: %v", err)
	}
	var assignment map[string]any
	if err := mustRead(t, storage, "work").ExtraFields[collaborationField].Decode(&assignment); err != nil {
		t.Fatal(err)
	}
	if got := assignment["collaborator"].(map[string]any)["uid"]; got != assignTestUID {
		t.Fatalf("assignment changed with profile move: collaborator uid = %#v", got)
	}
}

func TestShuttleAssign_ResolvesSemanticNamesWithinRoleAndStoresOnlyUIDs(t *testing.T) {
	defer resetAssignFlags()
	dir, storage := newStore(t)
	seedFiber(t, storage, "roles/vizier", assignTestRoleUID, "", nil, nil)
	seedFiber(t, storage, "roles/vizier/fable", assignTestUID, "", nil, nil)
	seedFiber(t, storage, "work", "", "", nil, nil)
	out, err := runCommand(t, dir, "shuttle", "assign", "work", "--role", "vizier", "--collaborator", "fable")
	if err != nil {
		t.Fatalf("assign semantic refs: %v\n%s", err, out)
	}
	var assignment map[string]map[string]any
	if err := mustRead(t, storage, "work").ExtraFields[collaborationField].Decode(&assignment); err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]string{"role": assignTestRoleUID, "collaborator": assignTestUID} {
		ref := assignment[key]
		if ref["uid"] != want || len(ref) != 1 {
			t.Fatalf("%s ref = %#v, want uid only", key, ref)
		}
	}
}

func TestShuttleAssign_RejectsNestedNotesAsCollaborators(t *testing.T) {
	defer resetAssignFlags()
	dir, storage := newStore(t)
	seedFiber(t, storage, "roles/vizier", assignTestRoleUID, "", nil, nil)
	seedFiber(t, storage, "roles/vizier/fable", assignTestUID, "", nil, nil)
	seedFiber(t, storage, "roles/vizier/fable/notes", "01D7QH6R8X9M2Q8D6Y0D5Q4C1A", "", nil, nil)
	seedFiber(t, storage, "work", "", "", nil, nil)

	if out, err := runCommand(t, dir, "shuttle", "assign", "work", "--role", "vizier", "--collaborator", "roles/vizier/fable/notes"); err == nil {
		t.Fatalf("nested notes path was assigned as a collaborator: %s", out)
	}

	// Stored UID references also have to resolve to a direct role child when a
	// command patches the pair, even if the original assignment predates this
	// constraint.
	work := mustRead(t, storage, "work")
	if err := work.SetExtraField(collaborationField, map[string]any{
		"role":         map[string]any{"uid": assignTestRoleUID},
		"collaborator": map[string]any{"uid": "01D7QH6R8X9M2Q8D6Y0D5Q4C1A"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := storage.Write(work); err != nil {
		t.Fatal(err)
	}
	resetAssignFlags()
	if out, err := runCommand(t, dir, "shuttle", "assign", "work", "--role", "vizier"); err == nil {
		t.Fatalf("patch accepted nested notes UID as a collaborator: %s", out)
	}
}

func TestShuttleAssign_RejectsAmbiguousNamesTraversalAndRoleMismatch(t *testing.T) {
	defer resetAssignFlags()
	dir, storage := newStore(t)
	seedFiber(t, storage, "roles/vizier", assignTestRoleUID, "", nil, nil)
	seedFiber(t, storage, "roles/other", "01D7QH6R8X9M2Q8D6Y0D5Q4C1A", "", nil, nil)
	seedFiber(t, storage, "roles/vizier/fable", assignTestUID, "", nil, nil)
	seedFiber(t, storage, "roles/vizier/another-fable", assignTestUID, "", nil, nil)
	seedFiber(t, storage, "roles/other/fable", "01C7QH6R8X9M2Q8D6Y0D5Q4C1A", "", nil, nil)
	seedFiber(t, storage, "work", "", "", nil, nil)
	cases := [][]string{
		{"--collaborator", "fable"},
		{"--role", "vizier", "--collaborator", assignTestUID},
		{"--collaborator", "../fable"},
		{"--role", "vizier", "--collaborator", "roles/other/fable"},
	}
	for _, flags := range cases {
		resetAssignFlags()
		args := append([]string{"shuttle", "assign", "work"}, flags...)
		if out, err := runCommand(t, dir, args...); err == nil {
			t.Fatalf("assign %v succeeded unexpectedly: %s", flags, out)
		}
	}
}

func TestShuttleAssign_UsesFullPathsAndStableUIDsAfterMove(t *testing.T) {
	defer resetAssignFlags()
	dir, storage := newStore(t)
	seedFiber(t, storage, "roles/vizier", assignTestRoleUID, "", nil, nil)
	seedFiber(t, storage, "roles/vizier/fable", assignTestUID, "", nil, nil)
	seedFiber(t, storage, "work", "", "", nil, nil)
	if out, err := runCommand(t, dir, "shuttle", "assign", "work", "--role", "roles/vizier", "--collaborator", "roles/vizier/fable"); err != nil {
		t.Fatalf("assign full paths: %v\n%s", err, out)
	}
	if err := storage.MoveSubtree("roles/vizier/fable", "roles/vizier/archivist"); err != nil {
		t.Fatal(err)
	}
	if _, err := storage.FindMetadataInScope("", assignTestUID); err != nil {
		t.Fatalf("UID did not survive profile move: %v", err)
	}
}

func TestShuttleAssign_InferRoleFromUniqueCollaboratorReference(t *testing.T) {
	defer resetAssignFlags()
	dir, storage := newStore(t)
	seedFiber(t, storage, "roles/vizier", assignTestRoleUID, "", nil, nil)
	seedFiber(t, storage, "roles/vizier/fable", assignTestUID, "", nil, nil)
	seedFiber(t, storage, "work", "", "", nil, nil)
	if out, err := runCommand(t, dir, "shuttle", "assign", "work", "--collaborator", "roles/vizier/fable"); err != nil {
		t.Fatalf("assign collaborator path: %v\n%s", err, out)
	}
	var assignment map[string]map[string]any
	if err := mustRead(t, storage, "work").ExtraFields[collaborationField].Decode(&assignment); err != nil {
		t.Fatal(err)
	}
	if assignment["role"]["uid"] != assignTestRoleUID || assignment["collaborator"]["uid"] != assignTestUID {
		t.Fatalf("inferred assignment = %#v", assignment)
	}
}

func TestShuttleAssign_ProjectViewResolvesRolesInEnclosingStore(t *testing.T) {
	defer resetAssignFlags()
	loom, project := newCrossStoreFixture(t)
	root := felt.NewStorage(loom)
	seedFiber(t, root, "roles/vizier", assignTestRoleUID, "", nil, nil)
	seedFiber(t, root, "roles/vizier/fable", assignTestUID, "", nil, nil)
	local := felt.NewStorage(project)
	seedFiber(t, local, "work", "", "", nil, nil)
	if out, err := runCommand(t, project, "shuttle", "assign", "work", "--role", "vizier", "--collaborator", "fable"); err != nil {
		t.Fatalf("assign in project view: %v\n%s", err, out)
	}
	var assignment map[string]map[string]any
	if err := mustRead(t, local, "work").ExtraFields[collaborationField].Decode(&assignment); err != nil {
		t.Fatal(err)
	}
	if assignment["role"]["uid"] != assignTestRoleUID || assignment["collaborator"]["uid"] != assignTestUID {
		t.Fatalf("stored assignment = %#v", assignment)
	}
}

func TestShuttleAssign_RolePatchCannotKeepMismatchedCollaborator(t *testing.T) {
	defer resetAssignFlags()
	dir, storage := newStore(t)
	seedFiber(t, storage, "roles/vizier", assignTestRoleUID, "", nil, nil)
	seedFiber(t, storage, "roles/other", "01D7QH6R8X9M2Q8D6Y0D5Q4C1A", "", nil, nil)
	seedFiber(t, storage, "roles/vizier/fable", assignTestUID, "", nil, nil)
	seedFiber(t, storage, "work", "", "", nil, nil)
	if _, err := runCommand(t, dir, "shuttle", "assign", "work", "--role", "vizier", "--collaborator", "fable"); err != nil {
		t.Fatal(err)
	}
	resetAssignFlags()
	if out, err := runCommand(t, dir, "shuttle", "assign", "work", "--role", "other"); err == nil || !strings.Contains(err.Error(), "does not belong") {
		t.Fatalf("mismatched role patch error = %v\n%s", err, out)
	}
}

func FuzzProfileQueryNeverEscapesRoles(f *testing.F) {
	for _, seed := range []string{"fable", "roles/vizier/fable", "roles/other/fable", "../fable", "roles/../secret", "", "\\roles\\vizier\\fable", assignTestUID} {
		f.Add(seed)
	}
	profiles := []*felt.Felt{
		{ID: "roles/vizier", UID: assignTestRoleUID, Name: "vizier"},
		{ID: "roles/vizier/fable", UID: assignTestUID, Name: "fable"},
		{ID: "roles/other", UID: "01D7QH6R8X9M2Q8D6Y0D5Q4C1A", Name: "other"},
		{ID: "roles/other/fable", UID: "01C7QH6R8X9M2Q8D6Y0D5Q4C1A", Name: "fable"},
		{ID: "outside/fable", UID: "01D7QH6R8X9M2Q8D6Y0D5Q4C1A", Name: "fable"},
	}
	f.Fuzz(func(t *testing.T, query string) {
		got := matchCollaboratorProfiles(profiles, query, "roles/vizier")
		for _, profile := range got {
			if profile.ID == "roles/vizier" || !strings.HasPrefix(profile.ID, "roles/vizier/") {
				t.Fatalf("query %q escaped role scope: %q", query, profile.ID)
			}
		}
		if validProfileQuery(query) && strings.Contains(query, "..") && len(got) != 0 {
			t.Fatalf("traversal-like query %q matched %#v", query, got)
		}
	})
}
