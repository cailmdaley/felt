package felt

import (
	"os"
	"testing"
)

// TestMain turns off fsync (see atomicfile) for this process: every store
// here lives in a temp dir.
func TestMain(m *testing.M) {
	if err := os.Setenv("FELT_TEST_FSYNC", "0"); err != nil {
		panic(err)
	}
	os.Exit(m.Run())
}
