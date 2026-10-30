//go:build !darwin && !linux

package progstatus

// Write emits nothing on platforms without a supported tty output queue check.
func Write(path string, b []byte) error { return nil }
