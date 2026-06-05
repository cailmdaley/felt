package cmd

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestAddMintsNativeUID(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	resetAdd := saveAddGlobals()
	defer resetAdd()
	resetLs := saveLsGlobals()
	defer resetLs()

	out, err := runCommand(t, dir, "add", "project/federated", "Federated")
	if err != nil {
		t.Fatalf("add: %v\n%s", err, out)
	}

	f, err := storage.Read("project/federated")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if !looksLikeULID(f.UID) {
		t.Fatalf("UID = %q, want ULID", f.UID)
	}
	data, err := f.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if !strings.Contains(string(data), "id: "+f.UID) {
		t.Fatalf("written markdown missing native id:\n%s", string(data))
	}

	jsonOut, err := runCommand(t, dir, "ls", "-j", "-s", "all", "--json-field", "id", "--json-field", "uid")
	if err != nil {
		t.Fatalf("ls json-field: %v\n%s", err, jsonOut)
	}
	var rows []map[string]string
	if err := json.Unmarshal([]byte(jsonOut), &rows); err != nil {
		t.Fatalf("json unmarshal: %v\n%s", err, jsonOut)
	}
	if len(rows) != 1 {
		t.Fatalf("rows = %v, want one row", rows)
	}
	if rows[0]["id"] != "project/federated" {
		t.Fatalf("json id = %q, want slug", rows[0]["id"])
	}
	if rows[0]["uid"] != f.UID {
		t.Fatalf("json uid = %q, want %q", rows[0]["uid"], f.UID)
	}
}

func saveAddGlobals() func() {
	prevBody := addBody
	prevStatus := addStatus
	prevDue := addDue
	prevTags := addTags
	prevOutcome := addOutcome
	prevTopLevel := addTopLevel
	prevJSON := jsonOutput

	addBody = ""
	addStatus = ""
	addDue = ""
	addTags = nil
	addOutcome = ""
	addTopLevel = false
	jsonOutput = false

	for _, name := range []string{"body", "status", "due", "tag", "outcome", "top-level", "json"} {
		if f := addCmd.Flags().Lookup(name); f != nil {
			f.Changed = false
		}
	}

	return func() {
		addBody = prevBody
		addStatus = prevStatus
		addDue = prevDue
		addTags = prevTags
		addOutcome = prevOutcome
		addTopLevel = prevTopLevel
		jsonOutput = prevJSON
	}
}

func looksLikeULID(value string) bool {
	if len(value) != 26 {
		return false
	}
	for _, r := range value {
		if !strings.ContainsRune("0123456789ABCDEFGHJKMNPQRSTVWXYZ", r) {
			return false
		}
	}
	return true
}
