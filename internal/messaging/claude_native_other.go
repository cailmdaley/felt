//go:build !linux && !darwin

package messaging

import (
	"fmt"
	"net"
)

func claudePeerPID(conn net.Conn) (int, error) {
	return 0, fmt.Errorf("native Claude peer identity is unavailable on this platform")
}
