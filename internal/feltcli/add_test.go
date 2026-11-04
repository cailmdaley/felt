package feltcli

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestAddDoesNotOverwriteConcurrentCreator(t *testing.T) {
	t.Parallel()
	dir, storage := newStore(t)
	unlock, err := storage.LockFiber("collision")
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	done := make(chan error, 1)
	go func() { _, err := runCommand(t, dir, "add", "collision", "Losing creator", "--top-level"); done <- err }()
	select {
	case err := <-done:
		t.Fatalf("add bypassed creation lock: %v", err)
	case <-time.After(200 * time.Millisecond):
	}
	winner := &felt.Felt{ID: "collision", Name: "Winning creator", Body: "Must survive"}
	if err := storage.Write(winner); err != nil {
		t.Fatal(err)
	}
	if err := unlock(); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("losing add = %v", err)
	}
	got := mustRead(t, storage, "collision")
	if got.UID != winner.UID || got.Name != winner.Name || got.Body != winner.Body {
		t.Fatalf("creator overwritten: %+v", got)
	}
}

func TestAddMintsNativeUID(t *testing.T) {
	t.Parallel()
	dir, storage := newStore(t)

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

func TestAddStampsUpdatedAtAtCreatedAt(t *testing.T) {
	t.Parallel()
	dir, storage := newStore(t)

	out, err := runCommand(t, dir, "add", "born", "Born")
	if err != nil {
		t.Fatalf("add: %v\n%s", err, out)
	}

	f, err := storage.Read("born")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	// A brand-new fiber's durable recency anchor is its birth: updated-at is
	// present and equal to created-at, so a fresh clone orders it sensibly
	// before it is ever edited.
	if f.UpdatedAt == nil {
		t.Fatalf("add did not stamp updated-at")
	}
	if !f.UpdatedAt.Equal(f.CreatedAt) {
		t.Fatalf("updated-at = %v, want created-at %v", f.UpdatedAt, f.CreatedAt)
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

// TestRolesPlacementIgnoresNestedRolesFibers: a deep fiber named "roles" must
// not capture the top-level roles namespace, whether a role is created by
// path or created at the top level and nested there afterwards.
func TestRolesPlacementIgnoresNestedRolesFibers(t *testing.T) {
	t.Parallel()
	dir, storage := newStore(t)

	for _, args := range [][]string{
		{"add", "games/civbench/harness-model/roles", "Harness roles"},
		{"add", "roles/vizier", "Vizier"},
		{"add", "roles/intendant", "Intendant"},
		{"add", "roles/intendant/opus", "Opus · intendant"},
		{"add", "--top-level", "steward", "Steward"},
		{"nest", "steward", "roles"},
	} {
		if out, err := runCommand(t, dir, args...); err != nil {
			t.Fatalf("%v: %v\n%s", args, err, out)
		}
	}
	for _, id := range []string{"roles/vizier", "roles/intendant", "roles/intendant/opus", "roles/steward"} {
		if _, err := storage.Read(id); err != nil {
			t.Fatalf("%s not placed exactly as spelled: %v", id, err)
		}
	}
	if _, err := storage.Read("games/civbench/harness-model/roles/steward"); err == nil {
		t.Fatal("nest resolved roles to a nested fiber named roles")
	}
}

// TestAddValidatesStatusLikeEdit: add and edit share one status rule. A bogus
// status is refused before anything is written, and -s closed stamps
// closed-at just as closing through edit does.
func TestAddValidatesStatusLikeEdit(t *testing.T) {
	t.Parallel()
	dir, storage := newStore(t)

	out, err := runCommand(t, dir, "add", "bogus", "Bogus", "-s", "bogus")
	if err == nil || !strings.Contains(err.Error(), `invalid status "bogus"`) {
		t.Fatalf("add -s bogus: err=%v out=%s; want an invalid-status refusal", err, out)
	}
	if _, err := storage.Read("bogus"); err == nil {
		t.Fatalf("add -s bogus wrote the fiber anyway")
	}

	if out, err := runCommand(t, dir, "add", "done", "Done", "-s", "closed"); err != nil {
		t.Fatalf("add -s closed: %v\n%s", err, out)
	}
	done, err := storage.Read("done")
	if err != nil {
		t.Fatalf("read done: %v", err)
	}
	if done.Status != felt.StatusClosed || done.ClosedAt == nil {
		t.Fatalf("add -s closed: status=%q closed-at=%v, want closed with a stamp", done.Status, done.ClosedAt)
	}
}
