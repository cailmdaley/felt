//go:build windows

package shuttlecli

import "time"

// lockEventsRotation has no cross-process lock on Windows; rotation there
// proceeds unguarded, as a single writer's would.
func lockEventsRotation(string, time.Duration) (unlock func(), ok bool) {
	return func() {}, true
}
