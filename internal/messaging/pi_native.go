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

	"github.com/cailmdaley/felt/internal/sysenv"
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

func piNativePath(env *sysenv.Env, id string) string {
	return filepath.Join(mailboxDir(env, "pi", id), "native.json")
}

func readPiNative(env *sysenv.Env, id string) (piNativeRegistration, error) {
	var registration piNativeRegistration
	b, err := readBounded(piNativePath(env, id), 16384)
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
// validated; Shuttle routes bytes and records the registration.
func RegisterPiNative(env *sysenv.Env, id, host, cwd, socket, transcript string, pid int, active bool) error {
	if _, err := FormatAddress(host, "pi", id); err != nil {
		return err
	}
	path := piNativePath(env, id)
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
	old, oldErr := readPiNative(env, id)
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
	if oldErr == nil && old.Host == host && old.ID == id && (old.Socket != socket || old.Device != registration.Device || old.Inode != registration.Inode || old.PID != pid) && piNativeAvailable(env, id, host) && piNativeListening(old.Socket) {
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

func piNativeAvailable(env *sysenv.Env, id, host string) bool {
	r, err := readPiNative(env, id)
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

func piNativeSessions(env *sysenv.Env, host string) []Session {
	root := filepath.Join(dataDir(env), "mailboxes", "pi")
	entries, err := os.ReadDir(root)
	if err != nil {
		return []Session{}
	}
	var sessions []Session
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		b, err := readBounded(filepath.Join(root, entry.Name(), "native.json"), 16384)
		if err != nil {
			continue
		}
		var r piNativeRegistration
		if json.Unmarshal(b, &r) != nil || r.Host != host || !piNativeAvailable(env, r.ID, host) || !piNativeListening(r.Socket) {
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

func sendPiNative(ctx context.Context, env *sysenv.Env, a Address, req Request) (Receipt, error) {
	receipt, err, _ := sendPiNativeWithDedupMetadata(ctx, env, a, req, 15*time.Second)
	return receipt, err
}

func sendPiNativeWithDedupMetadata(ctx context.Context, env *sysenv.Env, a Address, req Request, observationTimeout time.Duration) (Receipt, error, dedupMetadata) {
	metadata := dedupMetadata{}
	r, err := readPiNative(env, a.ID)
	if err != nil || r.ID != a.ID || r.Host != a.Host || !piNativeAvailable(env, a.ID, a.Host) {
		return rejected(req, piNativeTransport, "Pi session has not registered a native receiver endpoint"), errCode("preflight_failed", "Pi native receiver endpoint unavailable"), metadata
	}
	d := net.Dialer{Timeout: 2 * time.Second}
	conn, err := d.DialContext(ctx, "unix", r.Socket)
	if err != nil {
		return rejected(req, piNativeTransport, "Pi native socket unavailable"), errCode("preflight_failed", "Pi native socket unavailable: %v", err), metadata
	}
	defer conn.Close()
	deadline := time.Now().Add(15 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	if err := publishOwnerDeadline(ctx, deadline); err != nil {
		return rejected(req, piNativeTransport, "cannot persist delivery deadline"), errCode("preflight_failed", "cannot persist Pi native delivery deadline"), metadata
	}
	_ = conn.SetDeadline(deadline)
	transcript := openPiReceiptTranscript(r.Transcript, a.ID)
	if transcript != nil {
		defer transcript.Close()
	}
	if r.Transcript != "" {
		offset := int64(0)
		if transcript != nil {
			offset, _ = transcript.Seek(0, io.SeekCurrent)
		}
		metadata.TranscriptOffset = &offset
		metadata.PiContentHash = nativeContentHash(labeled(req))
	}
	observationDeadline := time.Now().Add(observationTimeout)
	if deadline.Before(observationDeadline) {
		observationDeadline = deadline
	}
	requestID := fmt.Sprintf("shuttle-pi-%d", time.Now().UnixNano())
	if err := json.NewEncoder(conn).Encode(map[string]any{"type": "msg", "requestId": requestID, "sessionId": a.ID, "message": labeled(req)}); err != nil {
		return Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusUnknown, Transport: piNativeTransport, Detail: "Pi native request write did not complete"}, errCode("ambiguous_delivery", "Pi native request may have reached the receiver: %v", err), metadata
	}
	line, err := bufio.NewReaderSize(io.LimitReader(conn, (512<<10)+1), 4096).ReadBytes('\n')
	if err != nil {
		if observePiReceiptHash(ctx, transcript, r.Transcript, a.ID, nativeContentHash(labeled(req)), observationDeadline) {
			return piTranscriptReceipt(req), nil, metadata
		}
		return Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusUnknown, Transport: piNativeTransport, Detail: "Pi native acknowledgement was not received"}, errCode("ambiguous_delivery", "Pi native acknowledgement was not received: %v", err), metadata
	}
	receipt, replyErr := decodePiNativeReply(line, requestID, a.ID, req)
	if receipt.Status == StatusQueued && r.Transcript == "" {
		receipt.Status = StatusUnknown
		receipt.Detail = "Pi has no session transcript; delivery is unconfirmed"
		replyErr = errCode("ambiguous_delivery", "%s", receipt.Detail)
	}
	if receipt.Status == StatusUnknown && observePiReceiptHash(ctx, transcript, r.Transcript, a.ID, nativeContentHash(labeled(req)), observationDeadline) {
		return piTranscriptReceipt(req), nil, metadata
	}
	return receipt, replyErr, metadata
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
	status := StatusAccepted
	if resp.Queued {
		status = StatusQueued
	}
	return Receipt{MessageID: req.MessageID, Address: req.Address, Status: status, Transport: piNativeTransport, Detail: resp.Delivery}, nil
}

type piNativeReply struct {
	Queued    bool   `json:"queued"`
	OK        *bool  `json:"ok"`
	Delivery  string `json:"delivery"`
	Error     string `json:"error"`
	RequestID string `json:"requestId"`
	SessionID string `json:"sessionId"`
}

// Pi persists admitted user input as a message row. Only new rows containing
// this exact labeled message in this session establish delivery.
func openPiReceiptTranscript(path, sessionID string) *os.File {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	reader := bufio.NewReader(f)
	line, err := reader.ReadBytes('\n')
	var header struct {
		Type string `json:"type"`
		ID   string `json:"id"`
	}
	if err != nil || json.Unmarshal(line, &header) != nil || header.Type != "session" || header.ID != sessionID {
		f.Close()
		return nil
	}
	// Preserve the send boundary even when the reader buffered historical rows.
	if _, err := f.Seek(0, io.SeekEnd); err != nil {
		f.Close()
		return nil
	}
	return f
}

func observePiReceipt(ctx context.Context, f *os.File, path, sessionID, text string, deadline time.Time) bool {
	return observePiReceiptHash(ctx, f, path, sessionID, nativeContentHash(text), deadline)
}

func observePiReceiptHash(ctx context.Context, f *os.File, path, sessionID, contentHash string, deadline time.Time) bool {
	if path == "" {
		return false
	}
	var reader *bufio.Reader
	headerPending := f == nil
	if f != nil {
		reader = bufio.NewReader(f)
	}
	var partial []byte
	discard := false
	for {
		if reader == nil {
			opened, err := os.Open(path)
			if err == nil {
				defer opened.Close()
				reader = bufio.NewReader(opened)
			}
		}
		if reader != nil {
			for {
				line, err := reader.ReadSlice('\n')
				if !discard {
					if len(partial)+len(line) > 2<<20 {
						discard = true
						partial = nil
					} else {
						partial = append(partial, line...)
					}
				}
				if err == bufio.ErrBufferFull {
					continue
				}
				if err == io.EOF {
					break
				}
				if err != nil {
					return false
				}
				if headerPending {
					var header struct {
						Type string `json:"type"`
						ID   string `json:"id"`
					}
					if discard || json.Unmarshal(partial, &header) != nil || header.Type != "session" || header.ID != sessionID {
						return false
					}
					headerPending = false
				} else if !discard {
					var row struct {
						Type    string `json:"type"`
						Message struct {
							Role    string          `json:"role"`
							Content json.RawMessage `json:"content"`
						} `json:"message"`
					}
					if json.Unmarshal(partial, &row) == nil && row.Type == "message" && row.Message.Role == "user" {
						var plain string
						var parts []struct {
							Type string `json:"type"`
							Text string `json:"text"`
						}
						if json.Unmarshal(row.Message.Content, &plain) != nil && json.Unmarshal(row.Message.Content, &parts) == nil {
							for _, part := range parts {
								if part.Type == "text" {
									plain += part.Text
								}
							}
						}
						if nativeContentHash(plain) == contentHash {
							return true
						}
					}
				}
				partial = nil
				discard = false
			}
		}
		if !time.Now().Before(deadline) {
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(25 * time.Millisecond):
		}
	}
}

// A repeated read observes admission without writing another socket request.
func refreshPiNativeReceipt(ctx context.Context, env *sysenv.Env, req Request, stored record) (nativeReceiptRefresh, bool) {
	address, err := ParseAddress(req.Address)
	if err != nil || address.Harness != "pi" || stored.PiContentHash == "" {
		return nativeReceiptRefresh{}, false
	}
	registration, err := readPiNative(env, address.ID)
	if err != nil || registration.ID != address.ID || registration.Host != address.Host {
		return nativeReceiptRefresh{}, false
	}
	f := openPiReceiptTranscript(registration.Transcript, address.ID)
	if f != nil {
		defer f.Close()
		if _, err := f.Seek(*stored.TranscriptOffset, io.SeekStart); err != nil {
			return nativeReceiptRefresh{}, false
		}
	}
	refreshCtx, cancel := context.WithTimeout(ctx, claudeRetryObservationTimeout)
	defer cancel()
	deadline, _ := refreshCtx.Deadline()
	if !observePiReceiptHash(refreshCtx, f, registration.Transcript, address.ID, stored.PiContentHash, deadline) {
		return nativeReceiptRefresh{}, false
	}
	upgraded := stored.Receipt
	upgraded.Status = StatusAccepted
	upgraded.Detail = "Pi transcript recorded this user message"
	return nativeReceiptRefresh{Receipt: upgraded}, true
}

func piTranscriptReceipt(req Request) Receipt {
	return Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusAccepted, Transport: piNativeTransport, Detail: "Pi transcript recorded this user message"}
}
