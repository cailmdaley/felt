//go:build windows

package cmd

// lockEventsRotation has no cross-process lock on Windows; rotation there
// proceeds unguarded, as a single writer's would.
func lockEventsRotation(string) (unlock func(), ok bool) {
	return func() {}, true
}
