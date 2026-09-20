package messaging

import (
	"bufio"
	"context"
	"crypto/sha256"
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

const claudeNativeTransport = "claude-native"

type claudeNativeRegistration struct {
	ID         string `json:"id"`
	Host       string `json:"host"`
	Socket     string `json:"socket"`
	Transcript string `json:"transcript"`
	Device     uint64 `json:"device"`
	Inode      uint64 `json:"inode"`
	PID        int    `json:"pid"`
}

// RegisterClaudeNative records the receiver's own hook environment. It never
// stores the child authentication token or launches another conversation.
func RegisterClaudeNative(id, host, cwd, socket, transcript string, active bool) error {
	if _, err := FormatAddress(host, "claude", id); err != nil {
		return err
	}
	path := filepath.Join(mailboxDir("claude", id), "native.json")
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
	old, oldErr := readClaudeNative(id)
	if !active {
		if oldErr != nil || old.Host != host || old.Socket != socket {
			return nil
		}
		// Hooks carry no endpoint generation. A delayed SessionEnd cannot
		// withdraw a still-live receiver that reused this native session id.
		if claudeNativeLive(id, host) {
			return nil
		}
		err := os.Remove(path)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	if !filepath.IsAbs(socket) || !filepath.IsAbs(transcript) || strings.ContainsAny(socket+transcript, "\x00\r\n") {
		return errCode("unavailable", "Claude receiver has no usable native endpoint")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	r := claudeNativeRegistration{ID: id, Host: host, Socket: socket, Transcript: transcript}
	info, err := claudeSocketInfo(socket)
	if err != nil {
		return err
	}
	st := info.Sys().(*syscall.Stat_t)
	r.Device = uint64(st.Dev)
	r.Inode = uint64(st.Ino)
	conn, err := (&net.Dialer{}).DialContext(ctx, "unix", socket)
	if err != nil {
		return err
	}
	defer conn.Close()
	r.PID, err = claudePeerPID(conn)
	if err != nil {
		return err
	}
	if oldErr == nil && old.Host == host && (old.Socket != r.Socket || old.Inode != r.Inode || old.PID != r.PID) {
		if existing, err := connectClaudeNative(ctx, old); err == nil {
			existing.Close()
			return errCode("unavailable", "another live Claude receiver owns this session")
		}
	}
	if err := ensureDir(filepath.Dir(path), 0700); err != nil {
		return err
	}
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	return mailboxWrite(path, b, false)
}

func readClaudeNative(id string) (claudeNativeRegistration, error) {
	var r claudeNativeRegistration
	b, err := mailboxRead(filepath.Join(mailboxDir("claude", id), "native.json"), 16384)
	if err == nil {
		err = json.Unmarshal(b, &r)
	}
	return r, err
}

func claudeSocketInfo(path string) (os.FileInfo, error) {
	parent, err := os.Lstat(filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	owner, ok := parent.Sys().(*syscall.Stat_t)
	if !ok || !parent.IsDir() || owner.Uid != uint32(os.Geteuid()) || parent.Mode().Perm()&0077 != 0 {
		return nil, errCode("unavailable", "Claude native socket directory is not private and receiver-owned")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || info.Mode()&os.ModeSocket == 0 || st.Uid != uint32(os.Geteuid()) || info.Mode().Perm()&0077 != 0 {
		return nil, errCode("unavailable", "Claude native socket is not private and receiver-owned")
	}
	return info, nil
}

func connectClaudeNative(ctx context.Context, r claudeNativeRegistration) (net.Conn, error) {
	info, err := claudeSocketInfo(r.Socket)
	if err != nil {
		return nil, err
	}
	st := info.Sys().(*syscall.Stat_t)
	if r.PID <= 0 || uint64(st.Dev) != r.Device || uint64(st.Ino) != r.Inode {
		return nil, errCode("unavailable", "Claude native endpoint was replaced; waiting for a receiver hook")
	}
	conn, err := (&net.Dialer{}).DialContext(ctx, "unix", r.Socket)
	if err != nil {
		return nil, err
	}
	pid, err := claudePeerPID(conn)
	if err != nil || pid != r.PID {
		conn.Close()
		return nil, errCode("unavailable", "Claude native endpoint process does not match its receiver registration")
	}
	return conn, nil
}

func claudeNativeUUID(r Request) string {
	h := sha256.Sum256([]byte("shuttle-claude-message\x00" + r.Address + "\x00" + r.MessageID))
	h[6] = (h[6] & 0x0f) | 0x50
	h[8] = (h[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", h[:4], h[4:6], h[6:8], h[8:10], h[10:16])
}

// claudeNativeLive verifies that the registered receiver still owns its bound
// endpoint. SessionEnd hooks use this when no generation identity is available.
func claudeNativeLive(id, host string) bool {
	r, err := readClaudeNative(id)
	if err != nil || r.ID != id || r.Host != host {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	conn, err := connectClaudeNative(ctx, r)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

func claudeNativeAvailable(id, host string) bool {
	r, err := readClaudeNative(id)
	if err != nil || r.ID != id || r.Host != host {
		return false
	}
	info, err := claudeSocketInfo(r.Socket)
	if err != nil {
		return false
	}
	st := info.Sys().(*syscall.Stat_t)
	return uint64(st.Dev) == r.Device && uint64(st.Ino) == r.Inode && r.PID > 0
}

func sendClaudeNative(ctx context.Context, a Address, req Request) (Receipt, error) {
	preflight := func(detail string) (Receipt, error) {
		return rejected(req, claudeNativeTransport, detail), errCode("preflight_failed", "%s", detail)
	}
	r, err := readClaudeNative(a.ID)
	if err != nil || r.ID != a.ID || r.Host != a.Host {
		return preflight("Claude session has not registered a native receiver endpoint")
	}
	f, err := openClaudeTranscript(r.Transcript, true)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return preflight("Claude receiver transcript cannot be observed: " + err.Error())
	}
	if f != nil {
		defer f.Close()
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	conn, err := connectClaudeNative(ctx, r)
	if err != nil {
		return preflight(err.Error())
	}
	defer conn.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetWriteDeadline(deadline)
	}
	uuid := claudeNativeUUID(req)
	from, verdicts, closeReceipts, err := listenClaudeNativeReceipts(ctx, r, uuid)
	if err != nil {
		return preflight("cannot listen for native Claude policy receipts: " + err.Error())
	}
	defer closeReceipts()
	body := struct {
		Type      string `json:"type"`
		SessionID string `json:"session_id"`
		UUID      string `json:"uuid"`
		MessageID string `json:"msg_id"`
		From      string `json:"from"`
		Priority  string `json:"priority"`
		Message   struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"message"`
	}{Type: "user", SessionID: a.ID, UUID: uuid, MessageID: uuid, From: from, Priority: "next"}
	body.Message.Role = "user"
	body.Message.Content = labeled(req)
	wire, err := json.Marshal(body)
	if err != nil {
		return preflight(err.Error())
	}
	wire = append(wire, '\n')
	n, err := conn.Write(wire)
	unknown := func(detail string) (Receipt, error) {
		return Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusUnknown, Transport: claudeNativeTransport, Detail: detail}, errCode("ambiguous_delivery", "%s", detail)
	}
	if err != nil || n != len(wire) {
		return unknown("native write did not complete; message may have reached Claude")
	}
	// The inbox has no direct acknowledgement. A correlated native transcript
	// branch is evidence that the receiver started processing this message.
	if err := observeClaudeTurn(ctx, f, r.Transcript, a.ID, uuid, verdicts); err != nil {
		var policy *claudePolicyError
		if errors.As(err, &policy) {
			if policy.status == "held" {
				return Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusUnknown, Transport: claudeNativeTransport, Detail: "receiver held this native message for approval; no turn started"}, errCode("wake_held", "receiver approval is required before the message can start a turn")
			}
			return rejected(req, claudeNativeTransport, "receiver native inbox "+policy.status+" this message; no turn started"), errCode("wake_refused", "receiver native inbox %s this message", policy.status)
		}
		return unknown("native message sent; no correlated receiver turn observed: " + err.Error())
	}
	return Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusAccepted, Transport: claudeNativeTransport, Detail: "receiver transcript confirms a model response descended from this native message; no claim of task completion"}, nil
}

type claudePolicyError struct{ status string }

func (e *claudePolicyError) Error() string { return "native inbox " + e.status }

func openClaudeTranscript(path string, tail bool) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.Mode().IsRegular() || !ok || stat.Uid != uint32(os.Geteuid()) {
		f.Close()
		return nil, fmt.Errorf("receiver transcript is not an owned regular file")
	}
	if tail {
		if _, err := f.Seek(0, io.SeekEnd); err != nil {
			f.Close()
			return nil, err
		}
	}
	return f, nil
}

func observeClaudeTurn(ctx context.Context, f *os.File, path, sessionID, uuid string, verdicts <-chan claudeNativeVerdict) error {
	var reader *bufio.Reader
	if f != nil {
		reader = bufio.NewReaderSize(f, 64<<10)
	}
	var pending []byte
	ancestry := map[string]bool{}
	total := 0
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		if reader == nil {
			observed, err := openClaudeTranscript(path, false)
			if err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			if observed != nil {
				defer observed.Close()
				reader = bufio.NewReaderSize(observed, 64<<10)
			}
		}
		var fragment []byte
		var err error = io.EOF
		if reader != nil {
			fragment, err = reader.ReadSlice('\n')
		}
		total += len(fragment)
		pending = append(pending, fragment...)
		if len(pending) > 1<<20 || total > 8<<20 {
			return fmt.Errorf("receiver evidence exceeds bounded scan")
		}
		if len(fragment) > 0 && fragment[len(fragment)-1] == '\n' {
			var row struct {
				Type       string          `json:"type"`
				SessionID  string          `json:"sessionId"`
				UUID       string          `json:"uuid"`
				ParentUUID string          `json:"parentUuid"`
				IsAPIError bool            `json:"isApiErrorMessage"`
				Error      json.RawMessage `json:"error"`
				Message    struct {
					Model string `json:"model"`
					Role  string `json:"role"`
				} `json:"message"`
			}
			if json.Unmarshal(pending, &row) == nil && row.SessionID == sessionID {
				if row.Type == "user" && row.UUID == uuid {
					ancestry[uuid] = true
				}
				if ancestry[row.ParentUUID] && row.UUID != "" {
					if row.Type == "assistant" {
						if row.IsAPIError || (len(row.Error) > 0 && string(row.Error) != "null") || row.Message.Model == "" || row.Message.Model == "<synthetic>" || row.Message.Role != "assistant" {
							return fmt.Errorf("receiver recorded an assistant error without a model response")
						}
						return nil
					}
					ancestry[row.UUID] = true
				}
			}
			pending = nil
		}
		if err == nil || errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if !errors.Is(err, io.EOF) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case verdict := <-verdicts:
			switch verdict.Status {
			case "held", "denied", "expired", "refused", "dropped":
				return &claudePolicyError{status: verdict.Status}
			}
		case <-ticker.C:
		}
	}
}
