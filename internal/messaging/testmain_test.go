package messaging

import (
	"os"
	"testing"
)

// TestMain turns off fsync (see atomicfile) for this process and the CLIs
// it runs: every mailbox here lives in a temp dir. Run with
// SHUTTLE_TEST_HARNESS_HOOK set, the test binary stands in for a harness
// process instead (see runTestHarness).
func TestMain(m *testing.M) {
	if os.Getenv("SHUTTLE_TEST_HARNESS_HOOK") != "" {
		runTestHarness()
		return
	}
	if err := os.Setenv("FELT_TEST_FSYNC", "0"); err != nil {
		panic(err)
	}
	os.Exit(m.Run())
}
