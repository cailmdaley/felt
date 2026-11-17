package feltcli

import (
	"encoding/json"
	"os"
	"path/filepath"
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

// felt add holds every segment it creates to the slug convention and names
// the conforming form; segments that already exist keep their spelling.
func TestAddRefusesNonConformingNewSlugs(t *testing.T) {
	t.Parallel()
	dir, s := newStore(t)
	writeFixtureFelt(t, s, "unions/shear_2d", "Shear")
	writeFixtureFelt(t, s, "c-ℓ-space", "Ell")
	for _, tc := range []struct{ slug, want string }{
		{"Foo Bar", `slug "Foo Bar" is not lowercase letters, digits and hyphens; use "foo-bar"`},
		{"v1.2", `use "v1-2"`},
		{".hidden", `use "hidden"`},
		{"new_dir/thing", `slug "new_dir" is not lowercase letters, digits and hyphens; use "new-dir"`},
		{"unions/shear_2d/Bad", `use "bad"`},
		{"unions/../x", `must be a path inside the store`},
	} {
		before := storeBytes(t, s.Root())
		if out, err := runCommand(t, dir, "add", tc.slug, "Name"); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("add %q: %v\n%s, want %s", tc.slug, err, out, tc.want)
		}
		if len(storeBytes(t, s.Root())) != len(before) {
			t.Fatalf("refused add %q wrote a file", tc.slug)
		}
	}
	for _, slug := range []string{"unions/shear_2d/new-thing", "c-ℓ-space/child", "shear_2d/placed"} {
		if out, err := runCommand(t, dir, "add", slug, "Name"); err != nil {
			t.Fatalf("add %q: %v\n%s", slug, err, out)
		}
	}
	mustRead(t, s, "unions/shear_2d/new-thing")
	mustRead(t, s, "unions/shear_2d/placed")
	mustRead(t, s, "c-ℓ-space/child")
}

// --uid carries an existing fiber, as the daemon does for a cross-host
// create: its identity and its slug arrive as spelled.
func TestAddUIDCarriesExistingSlug(t *testing.T) {
	t.Parallel()
	dir, s := newStore(t)
	uid := felt.NewULID()
	if out, err := runCommand(t, dir, "add", "work/spt3g_papers", "Papers", "--namespace", "--uid", uid); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if got := mustRead(t, s, "work/spt3g_papers"); got.UID != uid {
		t.Fatalf("uid = %q, want %q", got.UID, uid)
	}
	if _, err := runCommand(t, dir, "add", "other_one", "X", "--namespace"); err == nil || !strings.Contains(err.Error(), `use "other-one"`) {
		t.Fatalf("namespace create without --uid: %v", err)
	}
	if _, err := runCommand(t, dir, "add", "x", "X", "--uid", "not-a-ulid"); err == nil || !strings.Contains(err.Error(), "--uid must be a ULID") {
		t.Fatalf("bad uid: %v", err)
	}
}

// --uid carries a slug as spelled but only inside the store, with no segment
// starting with a dot, under a UID no fiber already holds, written upper-case;
// plain add refuses the same escapes.
func TestAddUIDStaysInsideStoreUnderAFreshUID(t *testing.T) {
	t.Parallel()
	dir, s := newStore(t)
	held := felt.NewULID()
	if out, err := runCommand(t, dir, "add", "held", "Held", "--uid", held); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	for _, tc := range []struct{ args []string }{
		{[]string{"../../escape", "X", "--uid", felt.NewULID()}},
		{[]string{"a/./b", "X", "--uid", felt.NewULID()}},
		{[]string{"/abs", "X", "--uid", felt.NewULID()}},
		{[]string{"a//b", "X", "--uid", felt.NewULID()}},
		{[]string{"again", "X", "--uid", held}},
		{[]string{"lower", "X", "--uid", strings.ToLower(held)}},
		{[]string{"../../escape", "X"}},
		{[]string{"/abs", "X"}},
		{[]string{"sub/.git", "X", "--uid", felt.NewULID()}},
		{[]string{".hidden", "X", "--uid", felt.NewULID()}},
		{[]string{"sub/.git", "X"}},
	} {
		before := storeBytes(t, s.Root())
		if out, err := runCommand(t, dir, append([]string{"add"}, tc.args...)...); err == nil {
			t.Fatalf("add %v succeeded:\n%s", tc.args, out)
		}
		if len(storeBytes(t, s.Root())) != len(before) {
			t.Fatalf("refused add %v wrote a file", tc.args)
		}
		if _, err := os.Stat(filepath.Join(s.Root(), "../../escape")); !os.IsNotExist(err) {
			t.Fatalf("add %v escaped the store: %v", tc.args, err)
		}
	}
	lower := strings.ToLower(felt.NewULID())
	if out, err := runCommand(t, dir, "add", "carried", "C", "--uid", lower); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if got := mustRead(t, s, "carried"); got.UID != strings.ToUpper(lower) {
		t.Fatalf("uid = %q, want upper-case %q", got.UID, strings.ToUpper(lower))
	}
}

// --uid refuses a UID any fiber of the enclosing store holds, outside the
// view it runs in too.
func TestAddUIDRefusesAUIDHeldInTheEnclosingStore(t *testing.T) {
	t.Parallel()
	tmp := t.TempDir()
	store := felt.NewStorage(filepath.Join(tmp, "store"))
	if err := store.Init(); err != nil {
		t.Fatal(err)
	}
	held := felt.NewULID()
	writeFixtureFelt(t, store, "proj", "Proj")
	if err := store.Write(&felt.Felt{ID: "other", Name: "Other", UID: held, CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	project := filepath.Join(tmp, "project")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(store.Root(), "proj"), filepath.Join(project, ".felt")); err != nil {
		t.Fatal(err)
	}
	if out, err := runCommand(t, project, "add", "x", "X", "--uid", held); err == nil || !strings.Contains(err.Error(), "already belongs to other") {
		t.Fatalf("add --uid held elsewhere in the store: %v\n%s", err, out)
	}
}

// A bare-form fiber outside the slug convention can still gain a child.
func TestAddUnderBareFormNonConformingFiber(t *testing.T) {
	t.Parallel()
	dir, s := newStore(t)
	if err := os.WriteFile(filepath.Join(s.Root(), "bare_one.md"), []byte("---\nname: Bare\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if out, err := runCommand(t, dir, "add", "bare_one/kid", "Kid"); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	mustRead(t, s, "bare_one/kid")
}
