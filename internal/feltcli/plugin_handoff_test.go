package feltcli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPluginRequiresCompleteHandoffPayload(t *testing.T) {
	t.Parallel()
	for _, missing := range []string{"handoff.sh", "handoff.mjs", filepath.Join("lib", "handoff.mjs")} {
		t.Run(missing, func(t *testing.T) {
			t.Parallel()
			root := t.TempDir()
			for _, name := range []string{".claude-plugin", "claude-plugin"} {
				if err := copyTree(filepath.Join(repoRoot(t), name), filepath.Join(root, name)); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.Remove(filepath.Join(root, "claude-plugin", "hooks", missing)); err != nil {
				t.Fatal(err)
			}
			if err := validatePluginCandidate(root, ""); err == nil || !strings.Contains(err.Error(), missing) {
				t.Fatalf("missing handoff payload should fail validation, got %v", err)
			}
		})
	}
}
