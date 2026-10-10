package messaging

import (
	"os"
	"runtime"
	"strings"
)

// ProcessBirthToken identifies one lifetime of pid. An empty token means the
// platform cannot establish identity; callers must not bind on pid alone.
func ProcessBirthToken(pid int) string {
	if pid <= 0 {
		return ""
	}
	start := processStartToken(pid)
	if start == "" {
		return ""
	}
	if runtime.GOOS == "linux" {
		boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
		if err != nil || strings.TrimSpace(string(boot)) == "" {
			return ""
		}
		return strings.TrimSpace(string(boot)) + ":" + start
	}
	return start
}
