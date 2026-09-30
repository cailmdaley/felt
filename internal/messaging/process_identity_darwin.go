//go:build darwin

package messaging

import (
	"encoding/binary"
	"errors"
	"strconv"
	"syscall"
	"unsafe"
)

// Darwin has no lightweight portable process-start token for the current
// process in the Go standard library, so dedup records use PID-only liveness
// there. A record that does carry a start token (see processStartToken) is
// checked against it.
func currentProcessStartTime() string { return "" }

func processAlive(pid int, start string) bool {
	if pid <= 0 {
		return false
	}
	if start != "" {
		return processStartToken(pid) == start
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// kinfoProc reads struct kinfo_proc for pid through sysctl
// {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid}. The layout is the 64-bit one
// shared by amd64 and arm64: 648 bytes, p_starttime at 0, p_comm at 243,
// e_ppid at 560. A pid with no process returns zero bytes.
func kinfoProc(pid int) ([]byte, bool) {
	if pid <= 0 {
		return nil, false
	}
	mib := [4]int32{1, 14, 1, int32(pid)}
	buf := make([]byte, 648)
	size := uintptr(len(buf))
	_, _, errno := syscall.Syscall6(syscall.SYS___SYSCTL, uintptr(unsafe.Pointer(&mib[0])), uintptr(len(mib)), uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)), 0, 0)
	if errno != 0 || size != uintptr(len(buf)) {
		return nil, false
	}
	return buf, true
}

func processStartToken(pid int) string {
	b, ok := kinfoProc(pid)
	if !ok {
		return ""
	}
	sec := binary.LittleEndian.Uint64(b[0:8])
	usec := binary.LittleEndian.Uint32(b[8:12])
	return strconv.FormatUint(sec, 10) + "." + strconv.FormatUint(uint64(usec), 10)
}

func processParent(pid int) (int, string, bool) {
	b, ok := kinfoProc(pid)
	if !ok {
		return 0, "", false
	}
	comm := b[243:260]
	n := 0
	for n < len(comm) && comm[n] != 0 {
		n++
	}
	return int(int32(binary.LittleEndian.Uint32(b[560:564]))), string(comm[:n]), true
}
