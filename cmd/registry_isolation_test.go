package cmd

import (
	"os"
	"path/filepath"
)

// See internal/shuttle/registry_isolation_test.go. Set here in an init rather
// than a TestMain because the integration suite (build tag `integration`,
// package cmd_test) already owns TestMain and two of them in one test binary
// will not link. The exported environment also reaches the felt binary those
// integration tests exec.
func init() {
	os.Setenv("FELT_AGENTS_FILE", filepath.Join(os.TempDir(), "felt-tests-no-such-agents.json"))
}
