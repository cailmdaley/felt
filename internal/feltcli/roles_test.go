package feltcli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

// felt roles lists each office once, with its charter's id: the store's own
// roles/<office>, or <mount>/roles/<office> in a repository linked in at the
// top; a person's instance beneath a charter and a charter deeper down are not
// offices.
func TestRolesListsChartersInTheStoreAndItsMounts(t *testing.T) {
	t.Parallel()
	dir, st := newStore(t)
	_, shared := newStore(t)
	for _, f := range []*felt.Felt{
		{ID: "roles/analyst", Name: "Analyst", Outcome: "Reads the data."},
		{ID: "roles/analyst/sam", Name: "Sam as analyst"},
		{ID: "roles/editor", Name: "Shared editor"},
		{ID: "notes/roles/deep", Name: "Too deep"},
	} {
		if err := shared.Write(f); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.Write(&felt.Felt{ID: "roles/editor", Name: "Editor"}); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(shared.Root(), filepath.Join(st.Root(), "shared")); err != nil {
		t.Fatal(err)
	}

	out, err := runCommand(t, dir, "roles", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var roles []RoleProfile
	if err := json.Unmarshal([]byte(out), &roles); err != nil {
		t.Fatal(err)
	}
	want := []RoleProfile{
		{Slug: "analyst", ID: "shared/roles/analyst", Name: "Analyst", Outcome: "Reads the data."},
		{Slug: "editor", ID: "roles/editor", Name: "Editor"},
	}
	if len(roles) != len(want) || roles[0] != want[0] || roles[1] != want[1] {
		t.Fatalf("roles = %+v", roles)
	}
	text, err := runCommand(t, dir, "roles")
	if err != nil || !strings.Contains(text, "analyst\tAnalyst\tReads the data.\n") {
		t.Fatalf("text: %q %v", text, err)
	}
	shown, err := runCommand(t, dir, "show", "roles/analyst")
	if err != nil || !strings.Contains(shown, "ID:       shared/roles/analyst\n") {
		t.Fatalf("felt show roles/analyst did not reach the mounted charter: %v\n%s", err, shown)
	}
}
