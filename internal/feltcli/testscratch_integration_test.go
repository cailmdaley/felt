//go:build integration

package feltcli

import "os"

// testScratch is a directory for fixtures built once per test binary and
// shared read-only by the tests that copy them; the unit build sets it in
// TestMain, which the integration build does not compile.
var testScratch = func() string {
	dir, err := os.MkdirTemp("", "felt-cli-test-*")
	if err != nil {
		panic(err)
	}
	return dir
}()
