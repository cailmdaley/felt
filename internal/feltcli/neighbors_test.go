package feltcli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestCheckAbsentNeighbors(t *testing.T) {
	t.Parallel()
	for _, mounted := range []bool{false, true} {
		t.Run(map[bool]string{false: "standalone", true: "mounted"}[mounted], func(t *testing.T) {
			dir, storage := newStore(t)
			if err := os.WriteFile(filepath.Join(storage.Root(), "shared.md"), []byte("---\nname: Shared\nneighbors: [commons]\nopaque: {anything: true}\n---\n[[commons/missing]] [[commons/other]] [[typo]]\n"), 0644); err != nil {
				t.Fatal(err)
			}
			if mounted {
				outer := t.TempDir()
				if err := os.MkdirAll(filepath.Join(outer, ".felt", "commons"), 0755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(outer, ".felt", "outer.md"), []byte("---\nname: Outer\n---\n"), 0644); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(storage.Root(), filepath.Join(outer, ".felt", "shared")); err != nil {
					t.Fatal(err)
				}
				view := t.TempDir()
				if err := os.Symlink(filepath.Join(outer, ".felt", "shared"), filepath.Join(view, ".felt")); err != nil {
					t.Fatal(err)
				}
				dir = view
			}
			output, err := runCommand(t, dir, "check", "--json")
			if err == nil {
				t.Fatal("typo must fail check")
			}
			var issues []felt.CheckIssue
			if err := json.Unmarshal([]byte(output), &issues); err != nil {
				t.Fatalf("%v: %s", err, output)
			}
			if mounted {
				if len(issues) != 3 {
					t.Fatalf("mounted links must be checked: %s", output)
				}
				for _, issue := range issues {
					if issue.Level != felt.CheckLevelError {
						t.Fatalf("unexpected issue: %+v", issue)
					}
				}
			} else {
				if len(issues) != 2 || issues[0].Level != felt.CheckLevelInfo || issues[0].Message != "not mounted, 2 links" || !strings.Contains(issues[1].Message, "typo") {
					t.Fatalf("unexpected issues: %s", output)
				}
				text, _ := runCommand(t, dir, "check")
				if !strings.Contains(text, "commons: not mounted, 2 links") {
					t.Fatal(text)
				}
			}
		})
	}
}
