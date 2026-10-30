package messaging

import (
	"os"
	"path/filepath"
	"syscall"
)

// ProcessTTY returns the device path of pid's controlling terminal, provided
// that device belongs to euid. An absent or unobservable terminal returns "".
// It reads kernel process metadata and device nodes without starting a process
// or opening the terminal itself.
func ProcessTTY(pid int, euid int) string {
	if pid <= 0 || euid < 0 {
		return ""
	}
	dev, ok := processTTYDev(pid)
	if !ok {
		return ""
	}
	return processTTYPath(pid, euid, dev)
}

func findTTY(pattern string, euid int, dev int32) string {
	paths, _ := filepath.Glob(pattern)
	for _, path := range paths {
		if matchesTTY(path, euid, dev) {
			return path
		}
	}
	return ""
}

func matchesTTY(path string, euid int, dev int32) bool {
	info, err := os.Stat(path)
	if err != nil || info.Mode()&os.ModeCharDevice == 0 {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(stat.Uid) == euid && int32(stat.Rdev) == dev
}
