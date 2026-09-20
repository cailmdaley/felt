//go:build linux

package messaging

import (
	"fmt"
	"net"
	"os"
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
	var cred *syscall.Ucred
	var socketErr error
	err = raw.Control(func(fd uintptr) {
		cred, socketErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	})
	if err != nil {
		return 0, err
	}
	if socketErr != nil {
		return 0, socketErr
	}
	if cred == nil || cred.Uid != uint32(os.Geteuid()) || cred.Pid <= 0 {
		return 0, fmt.Errorf("native peer is not owned by this user")
	}
	return int(cred.Pid), nil
}
