//go:build !linux && !darwin

package messaging

// No supported process-liveness probe exists outside the shipped Linux and
// Darwin targets. Fail closed so an unverified reservation is never resent
// and an unverified mailbox receiver is never advertised.
func currentProcessStartTime() string { return "" }

func processAlive(int, string) bool { return false }

func processStartToken(int) string { return "" }

func processParent(int) (int, string, bool) { return 0, "", false }
