package messaging

import (
	"os"
	"testing"
)

// TestMain turns off fsync (see atomicfile) for this process and the CLIs
// it runs: every mailbox here lives in a temp dir.
func TestMain(m *testing.M) {
	if err := os.Setenv("FELT_TEST_FSYNC", "0"); err != nil {
		panic(err)
	}
	os.Exit(m.Run())
}
