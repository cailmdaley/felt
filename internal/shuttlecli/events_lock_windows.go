//go:build windows

package shuttlecli

import (
	"errors"
	"time"
)

// flockWithin has no cross-process lock to take on Windows.
func flockWithin(string, time.Duration) (unlock func(), err error) {
	return nil, errors.New("no file lock on windows")
}
