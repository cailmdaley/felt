package shuttle

import (
	"path/filepath"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// testEnv is an isolated environment for one test: HOME is an empty temp
// directory and $SHUTTLE_AGENTS_FILE names a file that cannot exist, so
// LoadAgentRegistry sees the built-in layer alone and a developer's own
// registry can never turn a green run red (or a red one green). A test that
// wants a user layer sets the variable on the env it got.
func testEnv(t testing.TB) *sysenv.Env {
	t.Helper()
	dir := t.TempDir()
	return sysenv.New(dir, []string{
		"HOME=" + filepath.Join(dir, "home"),
		"SHUTTLE_AGENTS_FILE=" + filepath.Join(dir, "no-such-agents.json"),
	})
}
