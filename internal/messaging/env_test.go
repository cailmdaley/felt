package messaging

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// testEnv is an isolated environment for one test: its own HOME, data
// directory and Codex home under a fresh temp directory, so no test reads the
// developer's live mailboxes or sockets, and no two tests share state. PATH
// and TMPDIR pass through from the process.
func testEnv(t testing.TB) *sysenv.Env {
	t.Helper()
	dir := t.TempDir()
	return sysenv.New(dir, []string{
		"PATH=" + os.Getenv("PATH"),
		"TMPDIR=" + os.TempDir(),
		"HOME=" + filepath.Join(dir, "home"),
		"SHUTTLE_DATA_DIR=" + filepath.Join(dir, "shuttle"),
		"CODEX_HOME=" + filepath.Join(dir, "codex"),
		"SHUTTLE_CONFER_STATE_DIR=" + filepath.Join(dir, "confer"),
	})
}
