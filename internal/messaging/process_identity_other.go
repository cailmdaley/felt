//go:build !linux && !darwin

package messaging

// No supported process-liveness probe exists outside the shipped Linux and
// Darwin targets. Fail closed so an unverified reservation is never resent.
func currentProcessStartTime() string { return "" }

func processAlive(int, string) bool { return false }
