//go:build darwin

package messaging

import (
	"fmt"
	"net"
	"syscall"
)

func claudePeerPID(conn net.Conn) (int, error) {
	unix, ok := conn.(*net.UnixConn)
	if !ok {
		return 0, fmt.Errorf("not a Unix connection")
	}
	raw, err := unix.SyscallConn()
	if err != nil {
		return 0, err
	}
	var pid int
	var socketErr error
	// LOCAL_PEERPID returns the PID of the process bound to the Unix socket.
	err = raw.Control(func(fd uintptr) { pid, socketErr = syscall.GetsockoptInt(int(fd), 0, 2) })
	if err != nil {
		return 0, err
	}
	if socketErr != nil {
		return 0, socketErr
	}
	if pid <= 0 {
		return 0, fmt.Errorf("native peer PID unavailable")
	}
	return pid, nil
}
