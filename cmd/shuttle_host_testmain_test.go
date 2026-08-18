//go:build !integration

package cmd

import (
	"os"
	"path/filepath"
	"testing"
)

// TestMain fences the whole cmd unit-test binary away from the developer's real
// ~/.shuttle/host. resolveOwnHost's last tier now SEEDS that file (see
// seedHostConfigFile), so any test that reaches the OS-hostname fallback with
// SHUTTLE_HOST unset would otherwise write into the machine's canonical
// identity — quietly renaming the developer's host from a test run. Pointing
// SHUTTLE_HOST_FILE at a throwaway path makes the hazard unreachable by
// default; individual tests still override it with their own temp file.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "felt-cmd-hostfile-*")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(dir)
	if err := os.Setenv("SHUTTLE_HOST_FILE", filepath.Join(dir, "host")); err != nil {
		panic(err)
	}

	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}
