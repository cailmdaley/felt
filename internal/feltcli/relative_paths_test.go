//go:build !integration

package feltcli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

// The tests below give a relative path argument to an env whose working
// directory is not the test process's, and check the command used it there.

func TestMigrateDirResolvesInTheInvocationDirectory(t *testing.T) {
	t.Parallel()
	env, _ := testEnv(t)
	cwd := t.TempDir()
	if err := felt.NewStorage(filepath.Join(cwd, "relative-project")).Init(); err != nil {
		t.Fatal(err)
	}
	env.Chdir(cwd)
	for _, verb := range []string{"migrate", "backfill-ids"} {
		if _, stderr, err := executeIn(t, env, "", verb, "--dir", "relative-project", "--dry-run"); err != nil {
			t.Fatalf("%s --dir relative-project: %v\n%s", verb, err, stderr)
		}
	}
}

func TestSkillsTargetResolvesInTheInvocationDirectory(t *testing.T) {
	t.Parallel()
	env, _ := testEnv(t)
	source := t.TempDir()
	for _, dir := range []string{".claude-plugin", filepath.Join("claude-plugin", "skills", "relative-skill")} {
		if err := os.MkdirAll(filepath.Join(source, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(source, ".claude-plugin", "marketplace.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	cwd := t.TempDir()
	env.Chdir(cwd)
	stdout, stderr, err := executeIn(t, env, "", "setup", "skills", "--source", source, "--target", "relative-skills")
	if err != nil {
		t.Fatalf("setup skills: %v\n%s", err, stderr)
	}
	if !strings.Contains(stdout, "relative-skill") {
		t.Fatalf("no skill linked:\n%s", stdout)
	}
	if _, err := os.Lstat(filepath.Join(cwd, "relative-skills", "relative-skill")); err != nil {
		t.Fatalf("skill not linked in the invocation directory: %v", err)
	}
}
