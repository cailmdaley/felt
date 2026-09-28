//go:build darwin

package messaging

import (
	"errors"
	"syscall"
)

// Darwin has no lightweight portable process-start token in the Go standard
// library, so records use PID-only liveness there.
func currentProcessStartTime() string { return "" }

func processAlive(pid int, _ string) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
