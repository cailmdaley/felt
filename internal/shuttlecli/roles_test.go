package shuttlecli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestShuttleRolesSharedNamespace(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	loomDir, project := newCrossStoreFixture(t)
	loom := felt.NewStorage(loomDir)
	for _, f := range []*felt.Felt{
		{ID: "roles", Name: "Offices"},
		{ID: "roles/editor", Name: "Editor", Outcome: "Keeps text true."},
		{ID: "roles/editor/guide", Name: "Not an office"},
		{ID: "roles/warden", Name: "Warden"},
	} {
		if err := loom.Write(f); err != nil {
			t.Fatal(err)
		}
	}
	local := felt.NewStorage(project)
	if err := local.Write(&felt.Felt{ID: "roles/shadow", Name: "Project shadow"}); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{loomDir, project} {
		out, err := runIn(t, env, dir, "roles", "--json")
		if err != nil {
			t.Fatal(err)
		}
		var records []map[string]string
		if err := json.Unmarshal([]byte(out), &records); err != nil {
			t.Fatal(err)
		}
		if len(records) != 2 || records[0]["slug"] != "editor" || records[0]["name"] != "Editor" || records[0]["outcome"] != "Keeps text true." || records[1]["slug"] != "warden" || len(records[0]) != 3 {
			t.Fatalf("roles: %s", out)
		}
	}
	out, err := runIn(t, env, project, "roles")
	if err != nil || !strings.Contains(out, "editor\tEditor\tKeeps text true.") {
		t.Fatalf("text: %s %v", out, err)
	}
}

func TestShuttleRolesEmptyJSON(t *testing.T) {
	t.Parallel()
	dir, _ := newStore(t)
	out, err := runIn(t, testEnv(t), dir, "roles", "--json")
	if err != nil || strings.TrimSpace(out) != "[]" {
		t.Fatalf("%q %v", out, err)
	}
}

func TestShuttleRoleNewSharedCharter(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	loomDir, project := newCrossStoreFixture(t)
	local := felt.NewStorage(project)
	loom := felt.NewStorage(loomDir)
	seedShuttleRole(t, local, "hub", felt.StatusOpen, oneshot(), nil)
	before := mustRead(t, local, "hub")
	if out, err := runIn(t, env, project, "role", "hub", "editor", "--new", "Office editor"); err != nil {
		t.Fatalf("%s: %v", out, err)
	}
	charter := mustRead(t, loom, "roles/editor")
	if charter.Name != "Office editor" || !strings.Contains(charter.Body, before.Name) || !strings.Contains(charter.Body, "holders grow this charter") {
		t.Fatalf("charter: %+v", charter)
	}
	if _, err := os.Stat(local.Path("roles/editor")); !os.IsNotExist(err) {
		t.Fatalf("created project-local charter: %v", err)
	}
	if b := officeOf(t, local, "hub"); b.Role != "editor" || b.Seat {
		t.Fatalf("block: %+v", b)
	}
	if mustRead(t, local, "hub").Status != before.Status {
		t.Fatal("changed lifecycle")
	}
	data, err := os.ReadFile(loom.Path("roles/editor"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := runIn(t, env, project, "role", "hub", "editor", "--new", "Replacement"); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(loom.Path("roles/editor"))
	if string(data) != string(after) {
		t.Fatal("rewrote existing charter")
	}
}

func TestShuttleRoleNewValidatesBeforeCreation(t *testing.T) {
	t.Parallel()
	dir, st := newStore(t)
	env := testEnv(t)
	seedShuttleRole(t, st, "hub", felt.StatusOpen, oneshot(), nil)
	before, _ := os.ReadFile(st.Path("hub"))
	for _, args := range [][]string{
		{"role", "hub", "../escape", "--new", "Escape"},
		{"role", "hub", "roles/editor", "--new", "Editor"},
		{"role", "hub", "Bad", "--new", "Bad"},
		{"role", "hub", "bad--slug", "--new", "Bad"},
		{"role", "hub", "editor", "--new", " "},
		{"role", "hub", "--clear", "--new", "Editor"},
		{"role", "missing", "editor", "--new", "Editor"},
		{"role", "hub", "editor"},
	} {
		if _, err := runIn(t, env, dir, args...); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
	after, _ := os.ReadFile(st.Path("hub"))
	if string(before) != string(after) {
		t.Fatal("changed constitution")
	}
	profiles, err := listRoleProfiles(st)
	if err != nil || len(profiles) != 1 {
		t.Fatalf("created charter: %+v %v", profiles, err)
	}
}

func TestShuttleRoleNewPreservesMalformedCharter(t *testing.T) {
	t.Parallel()
	for _, layout := range []string{"directory", "mounted-bare"} {
		t.Run(layout, func(t *testing.T) {
			dir, st := newStore(t)
			seedShuttleRole(t, st, "hub", felt.StatusOpen, oneshot(), nil)
			if layout == "mounted-bare" {
				if err := os.Symlink(t.TempDir(), filepath.Join(dir, ".felt", "roles")); err != nil {
					t.Fatal(err)
				}
			}
			charterPath := st.Path("roles/editor")
			if layout == "mounted-bare" {
				charterPath = filepath.Join(dir, ".felt", "roles", "editor.md")
			}
			if err := os.MkdirAll(filepath.Dir(charterPath), 0755); err != nil {
				t.Fatal(err)
			}
			malformed := []byte("---\nname: [broken\n---\n\nKeep this charter exactly.\n")
			if err := os.WriteFile(charterPath, malformed, 0644); err != nil {
				t.Fatal(err)
			}
			if st.Path("roles/editor") != charterPath {
				t.Fatal("fixture is not the storage-resolved destination")
			}
			if roleRoots(st)["editor"] {
				t.Fatal("malformed charter unexpectedly indexed")
			}
			before, err := os.ReadFile(st.Path("hub"))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := runIn(t, testEnv(t), dir, "role", "hub", "editor", "--new", "Replacement"); err == nil {
				t.Fatal("accepted malformed existing charter")
			}
			after, err := os.ReadFile(charterPath)
			if err != nil {
				t.Fatal(err)
			}
			if string(after) != string(malformed) {
				t.Fatal("modified malformed charter bytes")
			}
			hub, err := os.ReadFile(st.Path("hub"))
			if err != nil {
				t.Fatal(err)
			}
			if string(hub) != string(before) {
				t.Fatal("modified constitution on refusal")
			}
		})
	}
}

func TestCreateRoleCharterRefusesDestinationErrors(t *testing.T) {
	t.Parallel()
	dir, st := newStore(t)
	// A non-directory ancestor yields ENOTDIR, not a missing charter.
	if err := os.WriteFile(filepath.Join(dir, ".felt", "roles"), []byte("occupied"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := createRoleCharter(st, &felt.Felt{ID: "roles/editor", Name: "Editor"}); err == nil {
		t.Fatal("ignored destination lookup error")
	}
}

func TestCreateRoleCharterSerializesCompetingCreators(t *testing.T) {
	t.Parallel()
	dir, st := newStore(t)
	type result struct {
		name string
		err  error
	}
	results := make(chan result, 2)
	start := make(chan struct{})
	for _, name := range []string{"First", "Second"} {
		go func(name string) {
			<-start
			err := createRoleCharter(felt.NewStorage(dir), &felt.Felt{ID: "roles/editor", Name: name})
			results <- result{name, err}
		}(name)
	}
	close(start)
	var winner string
	for range 2 {
		r := <-results
		if r.err == nil {
			if winner != "" {
				t.Fatal("both competing creations succeeded")
			}
			winner = r.name
		}
	}
	if winner == "" {
		t.Fatal("neither creator succeeded")
	}
	if got := mustRead(t, st, "roles/editor").Name; got != winner {
		t.Fatalf("winner %q was overwritten by %q", winner, got)
	}
}
