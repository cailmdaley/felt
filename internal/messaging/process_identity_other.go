//go:build !linux && !darwin

package messaging

import "errors"

// No supported process-liveness probe exists outside the shipped Linux and
// Darwin targets. Fail closed so an unverified reservation is never resent
// and an unverified mailbox receiver is never advertised.
func currentProcessStartTime() string { return "" }

func processAlive(int, string) bool { return false }

func processStartToken(int) string { return "" }

func processSignalZero(int) error { return errors.New("unsupported process identity probe") }

func processParent(int) (int, string, bool) { return 0, "", false }

func processTTYDev(int) (int32, bool) { return 0, false }

func processTTYPath(int, int, int32) string { return "" }
