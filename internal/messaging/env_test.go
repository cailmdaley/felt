package messaging

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// testEnv is an isolated environment for one test: its own HOME, an existing
// Shuttle data directory and a Codex home under a fresh temp directory, so no
// test reads the developer's live mailboxes or sockets, and no two tests share
// state. PATH and TMPDIR pass through from the process.
func testEnv(t testing.TB) *sysenv.Env {
	t.Helper()
	dir := t.TempDir()
	data := filepath.Join(dir, "shuttle")
	if err := os.Mkdir(data, 0o700); err != nil {
		t.Fatal(err)
	}
	return sysenv.New(dir, []string{
		"PATH=" + os.Getenv("PATH"),
		"TMPDIR=" + os.TempDir(),
		"HOME=" + filepath.Join(dir, "home"),
		"SHUTTLE_DATA_DIR=" + data,
		"CODEX_HOME=" + filepath.Join(dir, "codex"),
		"SHUTTLE_CONFER_STATE_DIR=" + filepath.Join(dir, "confer"),
	})
}

// pendingCount counts the entries an address's inbox holds that no worker has
// taken, future ones included.
func pendingCount(env *sysenv.Env, address string) (int, error) {
	entries, err := PendingEntries(env, address)
	return len(entries), err
}
