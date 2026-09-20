package messaging

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func nativeClaudeFixture(t *testing.T, respond func(map[string]any, *os.File)) (Request, *atomic.Int32) {
	t.Helper()
	dir, err := os.MkdirTemp("", "felt-cn-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	t.Setenv("SHUTTLE_DATA_DIR", dir)
	socket := filepath.Join(dir, "s.sock")
	transcript := filepath.Join(dir, "s.jsonl")
	f, err := os.OpenFile(transcript, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	if err := os.Chmod(socket, 0600); err != nil {
		t.Fatal(err)
	}
	var sent atomic.Int32
	go func() {
		for {
			c, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				scanner := bufio.NewScanner(c)
				if scanner.Scan() {
					var frame map[string]any
					if json.Unmarshal(scanner.Bytes(), &frame) == nil {
						sent.Add(1)
						respond(frame, f)
					}
				}
			}()
		}
	}()
	if err := RegisterMailbox("claude", "session", "host", dir, true); err != nil {
		t.Fatal(err)
	}
	if err := RegisterClaudeNative("session", "host", dir, socket, transcript, true); err != nil {
		t.Fatal(err)
	}
	return Request{Address: "shuttle://host/claude/session", Text: "hello", MessageID: "native-test", Wake: true}, &sent
}

func nativeRows(frame map[string]any, f *os.File, synthetic bool) {
	uuid := frame["uuid"].(string)
	rows := []map[string]any{
		{"type": "user", "sessionId": "session", "uuid": uuid},
		{"type": "attachment", "sessionId": "session", "uuid": "attachment", "parentUuid": uuid},
		{"type": "assistant", "sessionId": "session", "uuid": "assistant", "parentUuid": "attachment", "message": map[string]any{"role": "assistant", "model": "claude-test"}},
	}
	if synthetic {
		rows[2]["isApiErrorMessage"] = true
		rows[2]["message"] = map[string]any{"role": "assistant", "model": "<synthetic>"}
	}
	for _, row := range rows {
		b, _ := json.Marshal(row)
		f.Write(append(b, '\n'))
	}
}

func TestClaudeNativeWakeAndAttachmentRetry(t *testing.T) {
	req, sent := nativeClaudeFixture(t, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
	req.Attachments = []Attachment{{Name: "notes.bin", Data: []byte{0, 1, 255}}}
	// ReadAttachments owns digest generation; exercise the same public request path.
	file := filepath.Join(t.TempDir(), "notes.bin")
	os.WriteFile(file, []byte{0, 1, 255}, 0600)
	var err error
	req.Attachments, err = ReadAttachments([]string{file})
	if err != nil {
		t.Fatal(err)
	}
	r, err := Send(context.Background(), "host", req)
	if err != nil || r.Status != StatusAccepted || len(r.Files) != 1 {
		t.Fatalf("%+v %v", r, err)
	}
	retry, err := Send(context.Background(), "host", req)
	if err != nil || retry.Status != StatusAccepted || sent.Load() != 1 {
		t.Fatalf("retry %+v %v writes %d", retry, err, sent.Load())
	}
}

func TestClaudeNativeNoWakeAndUnknownRetry(t *testing.T) {
	req, sent := nativeClaudeFixture(t, func(map[string]any, *os.File) {})
	req.Wake = false
	r, err := Send(context.Background(), "host", req)
	if err != nil || r.Status != StatusQueued || sent.Load() != 0 {
		t.Fatalf("%+v %v", r, err)
	}
	req.Wake = true
	req.MessageID = "wake-timeout"
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	r, err = Send(ctx, "host", req)
	if err == nil || r.Status != StatusUnknown {
		t.Fatalf("%+v %v", r, err)
	}
	r, err = Send(context.Background(), "host", req)
	if err == nil || r.Status != StatusUnknown || sent.Load() != 1 {
		t.Fatalf("%+v %v writes %d", r, err, sent.Load())
	}
}

func TestClaudeNativeSyntheticErrorIsNotStarted(t *testing.T) {
	req, _ := nativeClaudeFixture(t, func(frame map[string]any, f *os.File) { nativeRows(frame, f, true) })
	r, err := Send(context.Background(), "host", req)
	if err == nil || r.Status != StatusUnknown || !strings.Contains(r.Detail, "assistant error") {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestClaudeNativeReplacedSocketRefusesBeforeSend(t *testing.T) {
	req, sent := nativeClaudeFixture(t, func(map[string]any, *os.File) {})
	reg, _ := readClaudeNative("session")
	reg.PID++
	b, _ := json.Marshal(reg)
	mailboxWrite(filepath.Join(mailboxDir("claude", "session"), "native.json"), b, false)
	r, err := Send(context.Background(), "host", req)
	if ErrorCode(err) != "preflight_failed" || r.Status != StatusRejected || sent.Load() != 0 {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestClaudeNativeEvidenceIgnoresUnrelatedAndMalformed(t *testing.T) {
	req, _ := nativeClaudeFixture(t, func(frame map[string]any, f *os.File) {
		f.WriteString("not json\n")
		frame["uuid"] = "unrelated"
		nativeRows(frame, f, false)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	r, err := Send(ctx, "host", req)
	if err == nil || r.Status != StatusUnknown {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestClaudeNativeRegistrationKeepsOneLiveOwner(t *testing.T) {
	_, _ = nativeClaudeFixture(t, func(map[string]any, *os.File) {})
	original, err := readClaudeNative("session")
	if err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(filepath.Dir(original.Socket), "other.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	os.Chmod(socket, 0600)
	if err := RegisterClaudeNative("session", "host", "/", socket, original.Transcript, true); err == nil {
		t.Fatal("replaced live receiver")
	}
	current, _ := readClaudeNative("session")
	if current.Socket != original.Socket {
		t.Fatalf("owner changed: %+v", current)
	}
	if err := RegisterClaudeNative("session", "host", "/", socket, original.Transcript, false); err != nil {
		t.Fatal(err)
	}
	if !claudeNativeAvailable("session", "host") {
		t.Fatal("other generation unregistered owner")
	}
	if err := RegisterClaudeNative("session", "host", "/", original.Socket, original.Transcript, false); err != nil {
		t.Fatal(err)
	}
	if !claudeNativeAvailable("session", "host") {
		t.Fatal("late SessionEnd withdrew live receiver")
	}
	if err := os.Remove(original.Socket); err != nil {
		t.Fatal(err)
	}
	if err := RegisterClaudeNative("session", "host", "/", original.Socket, original.Transcript, false); err != nil {
		t.Fatal(err)
	}
	if _, err := readClaudeNative("session"); !os.IsNotExist(err) {
		t.Fatalf("disconnected receiver still registered: %v", err)
	}
}

func TestClaudeNativeEvidenceRequiresExactSession(t *testing.T) {
	req, _ := nativeClaudeFixture(t, func(frame map[string]any, f *os.File) {
		uuid := frame["uuid"].(string)
		json.NewEncoder(f).Encode(map[string]any{"type": "user", "sessionId": "other-session", "uuid": uuid})
		json.NewEncoder(f).Encode(map[string]any{"type": "assistant", "sessionId": "session", "uuid": "assistant", "parentUuid": uuid, "message": map[string]any{"role": "assistant", "model": "claude-test"}})
	})
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	r, err := Send(ctx, "host", req)
	if err == nil || r.Status != StatusUnknown {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestClaudeNativePolicyReceipts(t *testing.T) {
	for _, status := range []string{"held", "denied", "expired", "refused", "dropped"} {
		t.Run(status, func(t *testing.T) {
			req, sent := nativeClaudeFixture(t, func(frame map[string]any, f *os.File) {
				reg, _ := readClaudeNative("session")
				c, err := net.Dial("unix", strings.TrimPrefix(frame["from"].(string), "uds:"))
				if err != nil {
					return
				}
				defer c.Close()
				payload := map[string]any{"type": "control", "action": "peer_message_status", "status": status, "from": "uds:" + reg.Socket, "orig_msg_id": frame["msg_id"]}
				if status == "refused" {
					payload["status"] = "expired"
					payload["status_detail"] = "refused"
				}
				json.NewEncoder(c).Encode(payload)
			})
			r, err := Send(context.Background(), "host", req)
			expected := StatusRejected
			if status == "held" {
				expected = StatusUnknown
			}
			if err == nil || r.Status != expected || !strings.Contains(r.Detail, status) {
				t.Fatalf("%+v %v", r, err)
			}
			r, err = Send(context.Background(), "host", req)
			if err == nil || r.Status != expected || sent.Load() != 1 {
				t.Fatalf("retry %+v %v writes %d", r, err, sent.Load())
			}
		})
	}
}

func TestClaudeNativeRejectsUncorrelatedPolicyReceipt(t *testing.T) {
	req, _ := nativeClaudeFixture(t, func(frame map[string]any, f *os.File) {
		reg, _ := readClaudeNative("session")
		c, err := net.Dial("unix", strings.TrimPrefix(frame["from"].(string), "uds:"))
		if err != nil {
			return
		}
		defer c.Close()
		json.NewEncoder(c).Encode(map[string]any{"type": "control", "action": "peer_message_status", "status": "denied", "from": "uds:" + reg.Socket, "orig_msg_id": "wrong-id"})
	})
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	r, err := Send(ctx, "host", req)
	if err == nil || r.Status != StatusUnknown {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestClaudeNativeRegistrationDoesNotWaitForHeldLock(t *testing.T) {
	_, _ = nativeClaudeFixture(t, func(map[string]any, *os.File) {})
	reg, _ := readClaudeNative("session")
	lock, err := os.OpenFile(filepath.Join(mailboxDir("claude", "session"), "native.lock"), os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	done := make(chan error, 1)
	go func() { done <- RegisterClaudeNative("session", "host", "/", reg.Socket, reg.Transcript, true) }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("registration ignored held lock")
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("registration blocks its receiver hook")
	}
}

func TestClaudeNativeObservesFirstTranscriptCreation(t *testing.T) {
	req, _ := nativeClaudeFixture(t, func(frame map[string]any, _ *os.File) {
		reg, _ := readClaudeNative("session")
		f, err := os.OpenFile(reg.Transcript, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			return
		}
		defer f.Close()
		nativeRows(frame, f, false)
	})
	reg, _ := readClaudeNative("session")
	if err := os.Remove(reg.Transcript); err != nil {
		t.Fatal(err)
	}
	r, err := Send(context.Background(), "host", req)
	if err != nil || r.Status != StatusAccepted {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestClaudeNativeReceivesPolicyWithoutTranscript(t *testing.T) {
	req, _ := nativeClaudeFixture(t, func(frame map[string]any, _ *os.File) {
		reg, _ := readClaudeNative("session")
		c, err := net.Dial("unix", strings.TrimPrefix(frame["from"].(string), "uds:"))
		if err != nil {
			return
		}
		defer c.Close()
		json.NewEncoder(c).Encode(map[string]any{"type": "control", "action": "peer_message_status", "status": "expired", "status_detail": "refused", "from": "uds:" + reg.Socket, "orig_msg_id": frame["msg_id"]})
	})
	reg, _ := readClaudeNative("session")
	if err := os.Remove(reg.Transcript); err != nil {
		t.Fatal(err)
	}
	r, err := Send(context.Background(), "host", req)
	if r.Status != StatusRejected || ErrorCode(err) != "wake_refused" {
		t.Fatalf("%+v %v", r, err)
	}
	if _, err := os.Stat(reg.Transcript); !os.IsNotExist(err) {
		t.Fatalf("adapter created transcript: %v", err)
	}
}

func TestClaudeNativeRefusesUnsafeTranscriptBeforeSend(t *testing.T) {
	for _, kind := range []string{"symlink", "fifo"} {
		t.Run(kind, func(t *testing.T) {
			req, sent := nativeClaudeFixture(t, func(map[string]any, *os.File) {})
			reg, _ := readClaudeNative("session")
			if err := os.Remove(reg.Transcript); err != nil {
				t.Fatal(err)
			}
			if kind == "symlink" {
				if err := os.Symlink(filepath.Join(t.TempDir(), "missing"), reg.Transcript); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := syscall.Mkfifo(reg.Transcript, 0600); err != nil {
					t.Fatal(err)
				}
			}
			r, err := Send(context.Background(), "host", req)
			if ErrorCode(err) != "preflight_failed" || r.Status != StatusRejected || sent.Load() != 0 {
				t.Fatalf("%+v %v writes %d", r, err, sent.Load())
			}
		})
	}
}
