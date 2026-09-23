package messaging

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const piNativeTransport = "pi-native"

type piNativeRegistration struct {
	ID         string `json:"id"`
	Host       string `json:"host"`
	CWD        string `json:"cwd"`
	Socket     string `json:"socket"`
	Transcript string `json:"transcript"`
	PID        int    `json:"pid"`
	Device     uint64 `json:"device"`
	Inode      uint64 `json:"inode"`
}

func piNativePath(id string) string {
	return filepath.Join(mailboxDir("pi", id), "native.json")
}

func readPiNative(id string) (piNativeRegistration, error) {
	var registration piNativeRegistration
	b, err := mailboxRead(piNativePath(id), 16384)
	if err == nil {
		err = json.Unmarshal(b, &registration)
	}
	return registration, err
}

func piNativeSocket(path string) (os.FileInfo, error) {
	if !filepath.IsAbs(path) || strings.ContainsAny(path, "\x00\r\n") {
		return nil, errCode("unavailable", "Pi native socket path is not usable")
	}
	parent, err := os.Lstat(filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	parentStat, ok := parent.Sys().(*syscall.Stat_t)
	if !ok || !parent.IsDir() || parent.Mode()&os.ModeSymlink != 0 || parentStat.Uid != uint32(os.Geteuid()) || parent.Mode().Perm()&0077 != 0 {
		return nil, errCode("unavailable", "Pi native socket directory is not private and receiver-owned")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || info.Mode()&os.ModeSocket == 0 || stat.Uid != uint32(os.Geteuid()) || info.Mode().Perm()&0077 != 0 {
		return nil, errCode("unavailable", "Pi native socket is not private and receiver-owned")
	}
	return info, nil
}

// RegisterPiNative records the endpoint owned by a running Pi extension. The
// extension owns the socket and calls pi.sendUserMessage after a request is
// validated; felt only routes bytes and records the registration.
func RegisterPiNative(id, host, cwd, socket, transcript string, pid int, active bool) error {
	if _, err := FormatAddress(host, "pi", id); err != nil {
		return err
	}
	path := piNativePath(id)
	if err := ensureDir(filepath.Dir(path), 0700); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(filepath.Dir(path), "native.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	old, oldErr := readPiNative(id)
	if !active {
		if oldErr != nil || old.Host != host || old.Socket != socket || old.PID != pid {
			return nil
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return syncDir(filepath.Dir(path))
	}
	if pid <= 0 || (transcript != "" && (!filepath.IsAbs(transcript) || strings.ContainsAny(transcript, "\x00\r\n"))) {
		return errCode("unavailable", "Pi receiver has no usable native identity")
	}
	info, err := piNativeSocket(socket)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return errCode("unavailable", "Pi native socket has no filesystem identity")
	}
	registration := piNativeRegistration{ID: id, Host: host, CWD: cwd, Socket: socket, Transcript: transcript, PID: pid, Device: uint64(stat.Dev), Inode: uint64(stat.Ino)}
	if oldErr == nil && old.Host == host && old.ID == id && (old.Socket != socket || old.Device != registration.Device || old.Inode != registration.Inode || old.PID != pid) && piNativeAvailable(id, host) && piNativeListening(old.Socket) {
		return errCode("unavailable", "another live Pi receiver owns this session")
	}
	b, err := json.Marshal(registration)
	if err != nil {
		return err
	}
	return mailboxWrite(path, b, false)
}

func piNativeListening(socket string) bool {
	conn, err := net.DialTimeout("unix", socket, 150*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func piNativeAvailable(id, host string) bool {
	r, err := readPiNative(id)
	if err != nil || r.ID != id || r.Host != host || r.PID <= 0 {
		return false
	}
	info, err := piNativeSocket(r.Socket)
	if err != nil {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && uint64(stat.Dev) == r.Device && uint64(stat.Ino) == r.Inode
}

func piNativeSessions(host string) []Session {
	root := filepath.Join(dataDir(), "mailboxes", "pi")
	entries, err := os.ReadDir(root)
	if err != nil {
		return []Session{}
	}
	var sessions []Session
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		b, err := mailboxRead(filepath.Join(root, entry.Name(), "native.json"), 16384)
		if err != nil {
			continue
		}
		var r piNativeRegistration
		if json.Unmarshal(b, &r) != nil || r.Host != host || !piNativeAvailable(r.ID, host) || !piNativeListening(r.Socket) {
			continue
		}
		address, err := FormatAddress(host, "pi", r.ID)
		if err != nil {
			continue
		}
		sessions = append(sessions, Session{Address: address, Host: host, Harness: "pi", ID: r.ID, CWD: r.CWD, State: "unknown", Capabilities: []string{"context", "wake", "steer"}})
	}
	return sessions
}

func sendPiNative(ctx context.Context, a Address, req Request) (Receipt, error) {
	r, err := readPiNative(a.ID)
	if err != nil || r.ID != a.ID || r.Host != a.Host || !piNativeAvailable(a.ID, a.Host) {
		return rejected(req, piNativeTransport, "Pi session has not registered a native receiver endpoint"), errCode("preflight_failed", "Pi native receiver endpoint unavailable")
	}
	d := net.Dialer{Timeout: 2 * time.Second}
	conn, err := d.DialContext(ctx, "unix", r.Socket)
	if err != nil {
		return rejected(req, piNativeTransport, "Pi native socket unavailable"), errCode("preflight_failed", "Pi native socket unavailable: %v", err)
	}
	defer conn.Close()
	deadline := time.Now().Add(15 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = conn.SetDeadline(deadline)
	requestID := fmt.Sprintf("shuttle-pi-%d", time.Now().UnixNano())
	if err := json.NewEncoder(conn).Encode(map[string]any{"type": "msg", "requestId": requestID, "sessionId": a.ID, "message": labeled(req)}); err != nil {
		return Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusUnknown, Transport: piNativeTransport, Detail: "Pi native request write did not complete"}, errCode("ambiguous_delivery", "Pi native request may have reached the receiver: %v", err)
	}
	line, err := bufio.NewReaderSize(io.LimitReader(conn, (512<<10)+1), 4096).ReadBytes('\n')
	if err != nil {
		return Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusUnknown, Transport: piNativeTransport, Detail: "Pi native acknowledgement was not received"}, errCode("ambiguous_delivery", "Pi native acknowledgement was not received: %v", err)
	}
	return decodePiNativeReply(line, requestID, a.ID, req)
}

func decodePiNativeReply(line []byte, requestID, sessionID string, req Request) (Receipt, error) {
	if len(line) > 512<<10 {
		return Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusUnknown, Transport: piNativeTransport, Detail: "Pi native acknowledgement exceeded limit"}, errCode("ambiguous_delivery", "Pi native acknowledgement exceeded limit")
	}
	var resp piNativeReply
	if err := json.Unmarshal(line, &resp); err != nil {
		return Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusUnknown, Transport: piNativeTransport, Detail: "Pi native acknowledgement lacked correlated evidence"}, errCode("ambiguous_delivery", "Pi native acknowledgement lacked correlated evidence")
	}
	if resp.RequestID != requestID || resp.SessionID != sessionID || resp.OK == nil {
		return Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusUnknown, Transport: piNativeTransport, Detail: "Pi native acknowledgement lacked correlated evidence"}, errCode("ambiguous_delivery", "Pi native acknowledgement lacked correlated evidence")
	}
	if !*resp.OK {
		return rejected(req, piNativeTransport, resp.Error), errCode("native_rejected", "Pi rejected prompt: %s", resp.Error)
	}
	if resp.Delivery != "steer" && resp.Delivery != "follow_up" {
		return Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusUnknown, Transport: piNativeTransport, Detail: "Pi native acknowledgement lacked correlated evidence"}, errCode("ambiguous_delivery", "Pi native acknowledgement lacked correlated evidence")
	}
	return Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusAccepted, Transport: piNativeTransport, Detail: resp.Delivery}, nil
}

type piNativeReply struct {
	OK        *bool  `json:"ok"`
	Delivery  string `json:"delivery"`
	Error     string `json:"error"`
	RequestID string `json:"requestId"`
	SessionID string `json:"sessionId"`
}
