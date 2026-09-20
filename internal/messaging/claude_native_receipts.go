package messaging

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"time"
)

type claudeNativeVerdict struct{ Status string }

// Claude returns inbox policy decisions to a sender-owned socket. Peer PID and
// the native correlation id are checked before accepting any receipt.
func listenClaudeNativeReceipts(ctx context.Context, r claudeNativeRegistration, uuid string) (string, <-chan claudeNativeVerdict, func(), error) {
	var nonce [6]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", nil, nil, err
	}
	path := filepath.Join(filepath.Dir(r.Socket), fmt.Sprintf("shuttle-%d-%x.sock", os.Getpid(), nonce))
	listener, err := net.Listen("unix", path)
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
