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
