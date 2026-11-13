package feltcli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestCheckAcceptsMarkdownCompanionsNotWikilinks(t *testing.T) {
	t.Parallel()
	dir, s := newStore(t)
	for _, f := range []*felt.Felt{
		{ID: "parent/source", Name: "Source", Body: "[scripts](scripts/) [relative](../briefs/) [file](runner) [[scripts]] [missing](missing/) [fiber](child/#absent)"},
		{ID: "parent/source/child", Name: "Child"},
	} {
		if err := s.Write(f); err != nil {
			t.Fatal(err)
		}
	}
	base := filepath.Dir(s.Path("parent/source"))
	for _, target := range []string{"scripts", "../briefs"} {
		if err := os.MkdirAll(filepath.Join(base, target), 0755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(base, "runner"), []byte("script"), 0644); err != nil {
		t.Fatal(err)
	}
	out, err := runCommand(t, dir, "check", "--json")
	if err == nil {
		t.Fatal("broken references must fail")
	}
	var issues []felt.CheckIssue
	if err := json.Unmarshal([]byte(out), &issues); err != nil {
		t.Fatal(err)
	}
	if len(issues) != 3 {
		t.Fatalf("want only wiki, missing, and fiber-fragment errors: %s", out)
	}
	for i, want := range []string{`broken body reference "child#absent": target has no element "absent"`, `broken body reference "missing"`, `broken body reference "scripts"`} {
		if !strings.Contains(issues[i].Message, want) {
			t.Fatalf("missing %s: %s", want, out)
		}
	}
}
