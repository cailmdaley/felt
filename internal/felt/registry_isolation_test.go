package felt

import (
	"os"
	"path/filepath"
)

// See internal/shuttle/registry_isolation_test.go — this package resolves
// shuttle blocks against the agent registry, which now reads a user config
// file. Isolate it so the suite depends on the built-ins alone.
func init() {
	os.Setenv("FELT_AGENTS_FILE", filepath.Join(os.TempDir(), "felt-tests-no-such-agents.json"))
}
