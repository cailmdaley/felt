package shuttlecli

import (
	"os"
	"path/filepath"
)

// The integration build excludes shuttlecli's TestMain, so set a disposable
// registry path before any test can load the user agent registry.
func init() {
	os.Setenv("SHUTTLE_AGENTS_FILE", filepath.Join(os.TempDir(), "shuttle-tests-no-such-agents.json"))
}
