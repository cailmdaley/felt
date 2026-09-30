//go:build linux

package messaging

import (
	"errors"
	"os"
	"strconv"
	"strings"
	"syscall"
)

func currentProcessStartTime() string {
	start, ok := linuxProcessStartTime(os.Getpid())
	if !ok {
		return ""
	}
	return start
}

func processAlive(pid int, start string) bool {
	if pid <= 0 {
		return false
	}
	actual, ok := linuxProcessStartTime(pid)
	if start != "" {
		return ok && actual == start
	}
	if ok {
		return true
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

func processStartToken(pid int) string {
	start, _ := linuxProcessStartTime(pid)
	return start
}

// processParent reads the parent pid (field 4) and command name (field 2) of
// pid from /proc/<pid>/stat.
func processParent(pid int) (int, string, bool) {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0, "", false
	}
	s := string(b)
	openParen := strings.IndexByte(s, '(')
	closeParen := strings.LastIndexByte(s, ')')
	if openParen < 0 || closeParen < openParen {
		return 0, "", false
	}
	fields := strings.Fields(s[closeParen+1:])
	if len(fields) < 2 {
		return 0, "", false
	}
	ppid, err := strconv.Atoi(fields[1])
	if err != nil {
		return 0, "", false
	}
	return ppid, s[openParen+1 : closeParen], true
}

// linuxProcessStartTime reads field 22 from /proc/<pid>/stat. The command name
// is parenthesized and may itself contain spaces or parentheses, so split only
// after its final closing parenthesis.
func linuxProcessStartTime(pid int) (string, bool) {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return "", false
	}
	closeParen := strings.LastIndexByte(string(b), ')')
	if closeParen < 0 {
		return "", false
	}
	fields := strings.Fields(string(b[closeParen+1:]))
	// The suffix starts at field 3 (state), so starttime (field 22) is index 19.
	if len(fields) <= 19 {
		return "", false
	}
	return fields[19], true
}
