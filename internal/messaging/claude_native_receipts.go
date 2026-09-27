package messaging

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

type claudeNativeVerdict struct{ Status string }

// maxUnixSocketPath is the longest socket path that binds on both macOS
// (sun_path 104 bytes with its NUL) and Linux (108).
const maxUnixSocketPath = 103

// Claude returns inbox policy decisions to a sender-owned socket. Claude only
// replies to an address beside its own socket (its private cc-socks dir), and
// on macOS that dir sits under a long $TMPDIR, so the receipt name is sized to
// the remaining sun_path budget: "<hex>.sock", the shape Claude itself uses
// for peer sockets. Peer PID and the native correlation id are checked before
// accepting any receipt.
func listenClaudeNativeReceipts(ctx context.Context, r claudeNativeRegistration, uuid string) (string, <-chan claudeNativeVerdict, func(), error) {
	listener, path, err := listenBesideSocket(r.Socket)
	if err != nil {
		return "", nil, nil, err
	}
	if err := os.Chmod(path, 0600); err != nil {
		listener.Close()
		return "", nil, nil, err
	}
	verdicts := make(chan claudeNativeVerdict, 8)
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			pid, err := claudePeerPID(conn)
			if err != nil || pid != r.PID {
				conn.Close()
				continue
			}
			conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
			scanner := bufio.NewScanner(conn)
			scanner.Buffer(make([]byte, 4096), 8192)
			if scanner.Scan() {
				var frame struct {
					Type         string `json:"type"`
					Action       string `json:"action"`
					Status       string `json:"status"`
					StatusDetail string `json:"status_detail"`
					ID           string `json:"orig_msg_id"`
					From         string `json:"from"`
				}
				if json.Unmarshal(scanner.Bytes(), &frame) == nil && frame.Type == "control" && frame.Action == "peer_message_status" && frame.ID == uuid && frame.From == "uds:"+r.Socket {
					if frame.Status == "expired" && frame.StatusDetail == "refused" {
						frame.Status = "refused"
					}
					select {
					case verdicts <- claudeNativeVerdict{Status: frame.Status}:
					case <-ctx.Done():
						conn.Close()
						return
					}
				}
			}
			conn.Close()
		}
	}()
	return "uds:" + path, verdicts, func() { listener.Close() }, nil
}

// listenBesideSocket binds a fresh random "<hex>.sock" in socket's directory,
// with as many hex digits (up to 16) as the path limit allows.
func listenBesideSocket(socket string) (net.Listener, string, error) {
	dir := filepath.Dir(socket)
	digits := min(16, maxUnixSocketPath-len(dir)-len("/.sock"))
	if digits < 6 {
		return nil, "", fmt.Errorf("socket directory %q leaves no room for a receipt socket within %d bytes", dir, maxUnixSocketPath)
	}
	for attempt := 0; ; attempt++ {
		var nonce [8]byte
		if _, err := rand.Read(nonce[:]); err != nil {
			return nil, "", err
		}
		path := filepath.Join(dir, fmt.Sprintf("%x", nonce)[:digits]+".sock")
		listener, err := net.Listen("unix", path)
		if err == nil || !errors.Is(err, syscall.EADDRINUSE) || attempt == 3 {
			return listener, path, err
		}
	}
}
