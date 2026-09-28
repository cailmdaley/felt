package messaging

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
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

func TestObserveClaudeTurnReportsFurthestObservedStage(t *testing.T) {
	const (
		uuid    = "message-uuid"
		content = "the queued content"
	)
	tests := []struct {
		name  string
		rows  []map[string]any
		stage string
	}{
		{
			name:  "queue operation is queued",
			rows:  []map[string]any{{"type": "queue-operation", "operation": "enqueue", "sessionId": "session", "content": content}},
			stage: StatusQueued,
		},
		{
			name:  "native user row is submitted",
			rows:  []map[string]any{{"type": "user", "sessionId": "session", "uuid": uuid}},
			stage: StatusSubmitted,
		},
		{
			name:  "queued command attachment is submitted",
			rows:  []map[string]any{{"type": "attachment", "sessionId": "session", "uuid": "queued", "attachment": map[string]any{"type": "queued_command", "source_uuid": uuid}}},
			stage: StatusSubmitted,
		},
		{
			name: "real correlated assistant row is accepted",
			rows: []map[string]any{
				{"type": "user", "sessionId": "session", "uuid": uuid},
				{"type": "assistant", "sessionId": "session", "uuid": "assistant", "parentUuid": uuid, "message": map[string]any{"role": "assistant", "model": "claude-test"}},
			},
			stage: StatusAccepted,
		},
		{name: "no evidence stays unknown", stage: StatusUnknown},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "transcript.jsonl")
			f, err := os.Create(path)
			if err != nil {
				t.Fatal(err)
			}
			for _, row := range tc.rows {
				if err := json.NewEncoder(f).Encode(row); err != nil {
					t.Fatal(err)
				}
			}
			if err := f.Close(); err != nil {
				t.Fatal(err)
			}
			f, err = os.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 35*time.Millisecond)
			defer cancel()
			stage, err := observeClaudeTurn(ctx, f, path, "session", uuid, claudeContentHash(content), nil)
			if stage != tc.stage {
				t.Fatalf("stage = %q, want %q (err %v)", stage, tc.stage, err)
			}
			if tc.stage == StatusAccepted {
				if err != nil {
					t.Fatalf("accepted row: %v", err)
				}
			} else if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("incomplete stage error = %v, want deadline", err)
			}
		})
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
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
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

// busyReceiverRows mirrors a Claude receiver that is mid-turn when the message
// arrives: it enqueues the prompt, finishes the running tool step, and absorbs
// the message as a queued_command attachment rather than a new user turn.
func busyReceiverRows(frame map[string]any, f *os.File, absorb bool) {
	uuid := frame["uuid"].(string)
	content := frame["message"].(map[string]any)["content"].(string)
	rows := []map[string]any{
		{"type": "queue-operation", "operation": "enqueue", "sessionId": "session", "content": content},
		{"type": "assistant", "sessionId": "session", "uuid": "tool-call", "parentUuid": "earlier", "message": map[string]any{"role": "assistant", "model": "claude-test"}},
	}
	if absorb {
		rows = append(rows,
			map[string]any{"type": "user", "sessionId": "session", "uuid": "tool-result", "parentUuid": "tool-call"},
			map[string]any{"type": "queue-operation", "operation": "remove", "reason": "absorbed_mid_turn", "sessionId": "session", "content": content},
			map[string]any{"type": "attachment", "sessionId": "session", "uuid": "absorbed", "parentUuid": "tool-result", "attachment": map[string]any{"type": "queued_command", "source_uuid": uuid, "commandMode": "prompt", "prompt": content}},
			map[string]any{"type": "attachment", "sessionId": "session", "uuid": "reminder", "parentUuid": "absorbed", "attachment": map[string]any{"type": "output_style"}},
			map[string]any{"type": "assistant", "sessionId": "session", "uuid": "response", "parentUuid": "reminder", "message": map[string]any{"role": "assistant", "model": "claude-test"}},
		)
	}
	for _, row := range rows {
		b, _ := json.Marshal(row)
		f.Write(append(b, '\n'))
	}
}

func TestClaudeNativeRetryRefreshesReceiptWithoutResending(t *testing.T) {
	frameCh := make(chan map[string]any, 1)
	req, sent := nativeClaudeFixture(t, func(frame map[string]any, _ *os.File) { frameCh <- frame })
	registration, err := readClaudeNative("session")
	if err != nil {
		t.Fatal(err)
	}
	prefix := make([]byte, 9<<20)
	if err := os.WriteFile(registration.Transcript, prefix, 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	first, firstErr := Send(ctx, "host", req)
	cancel()
	if first.Status != StatusUnknown || ErrorCode(firstErr) != "ambiguous_delivery" {
		t.Fatalf("first receipt: %+v %v", first, firstErr)
	}
	frame := <-frameCh
	transcript, err := os.OpenFile(registration.Transcript, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	busyReceiverRows(frame, transcript, true)
	if err := transcript.Close(); err != nil {
		t.Fatal(err)
	}

	upgraded, err := Send(context.Background(), "host", req)
	if err != nil || upgraded.Status != StatusAccepted || sent.Load() != 1 {
		t.Fatalf("retry: %+v %v socket writes=%d", upgraded, err, sent.Load())
	}
	name := sha256.Sum256([]byte(req.MessageID))
	stored, err := readDedupRecord(filepath.Join(dataDir(), "messages", hex.EncodeToString(name[:])+".json"))
	if err != nil || stored.Receipt.Status != StatusAccepted || stored.ErrorCode != "" || stored.TranscriptOffset == nil || *stored.TranscriptOffset != int64(len(prefix)) {
		t.Fatalf("stored upgrade: %+v err=%v", stored, err)
	}
}

func TestClaudeNativeRetryReturnsObservedStageWhenRefreshLockIsBusy(t *testing.T) {
	req, sent := nativeClaudeFixture(t, func(map[string]any, *os.File) {})
	registration, err := readClaudeNative("session")
	if err != nil {
		t.Fatal(err)
	}
	transcript, err := os.OpenFile(registration.Transcript, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewEncoder(transcript).Encode(map[string]any{"type": "user", "sessionId": "session", "uuid": claudeNativeUUID(req)}); err != nil {
		t.Fatal(err)
	}
	if err := transcript.Close(); err != nil {
		t.Fatal(err)
	}
	offset := int64(0)
	stored := record{
		Hash: requestHash(req), State: "complete",
		Receipt:   Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusUnknown, Transport: claudeNativeTransport, Detail: "stored unknown"},
		ErrorCode: "ambiguous_delivery", ErrorMessage: "stored unknown",
		TranscriptOffset: &offset, ClaudeQueueContentHash: claudeContentHash(labeled(req)),
	}
	writeDedupRecord(t, dataDir(), req, stored)
	lock, err := os.OpenFile(filepath.Join(dataDir(), "messages", ".refresh.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)

	receipt, err := Send(context.Background(), "host", req)
	if err != nil || receipt.Status != StatusSubmitted || sent.Load() != 0 {
		t.Fatalf("retry returned stale receipt or resent: %+v %v writes=%d", receipt, err, sent.Load())
	}
}

func TestClaudeNativeRetryWithoutOffsetKeepsStoredReceipt(t *testing.T) {
	req, sent := nativeClaudeFixture(t, func(map[string]any, *os.File) {})
	frame := map[string]any{"uuid": claudeNativeUUID(req)}
	registration, err := readClaudeNative("session")
	if err != nil {
		t.Fatal(err)
	}
	transcript, err := os.OpenFile(registration.Transcript, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	nativeRows(frame, transcript, false)
	if err := transcript.Close(); err != nil {
		t.Fatal(err)
	}
	storedReceipt := Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusUnknown, Transport: claudeNativeTransport, Detail: "stored unknown"}
	writeDedupRecord(t, dataDir(), req, record{Hash: requestHash(req), State: "complete", Receipt: storedReceipt, ErrorCode: "ambiguous_delivery", ErrorMessage: "stored unknown"})

	receipt, err := Send(context.Background(), "host", req)
	if ErrorCode(err) != "ambiguous_delivery" || !reflect.DeepEqual(receipt, storedReceipt) || sent.Load() != 0 {
		t.Fatalf("retry changed an offset-less record or wrote to socket: %+v %v writes=%d", receipt, err, sent.Load())
	}
}

func TestClaudeNativeMidTurnAbsorptionIsAccepted(t *testing.T) {
	req, _ := nativeClaudeFixture(t, func(frame map[string]any, f *os.File) { busyReceiverRows(frame, f, true) })
	r, err := Send(context.Background(), "host", req)
	if err != nil || r.Status != StatusAccepted {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestClaudeNativeQueuedBehindTurnReportsQueueAdmission(t *testing.T) {
	req, _ := nativeClaudeFixture(t, func(frame map[string]any, f *os.File) { busyReceiverRows(frame, f, false) })
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	r, err := Send(ctx, "host", req)
	if err != nil || r.Status != StatusQueued || r.Detail != "queued behind the receiver's current turn; it runs when that turn ends" {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestClaudeNativeAbsorptionOfAnotherMessageIsNotEvidence(t *testing.T) {
	req, _ := nativeClaudeFixture(t, func(frame map[string]any, f *os.File) {
		frame["uuid"] = "another-message"
		frame["message"] = map[string]any{"content": "another message"}
		busyReceiverRows(frame, f, true)
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	r, err := Send(ctx, "host", req)
	if err == nil || r.Status != StatusUnknown || strings.Contains(r.Detail, "queued") {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestClaudeNativeSyntheticErrorIsNotStarted(t *testing.T) {
	req, sent := nativeClaudeFixture(t, func(frame map[string]any, f *os.File) { nativeRows(frame, f, true) })
	first, err := Send(context.Background(), "host", req)
	const detail = "the receiver took the message but its turn ended in an error without a model reply"
	if first.Status != StatusUnknown || first.Detail != detail || ErrorCode(err) != "receiver_turn_failed" {
		t.Fatalf("first receipt: %+v %v", first, err)
	}
	retry, err := Send(context.Background(), "host", req)
	if retry.Status != StatusUnknown || retry.Detail != detail || ErrorCode(err) != "receiver_turn_failed" || sent.Load() != 1 {
		t.Fatalf("retry upgraded a failed turn or resent: %+v %v writes=%d", retry, err, sent.Load())
	}
}

func TestClaudeNativeScanFailureAfterQueueIsUnknown(t *testing.T) {
	req, _ := nativeClaudeFixture(t, func(frame map[string]any, f *os.File) {
		content := frame["message"].(map[string]any)["content"].(string)
		row := map[string]any{"type": "queue-operation", "operation": "enqueue", "sessionId": "session", "content": content}
		if err := json.NewEncoder(f).Encode(row); err != nil {
			return
		}
		_, _ = io.WriteString(f, strings.Repeat("x", 9<<20))
	})
	r, err := Send(context.Background(), "host", req)
	if r.Status != StatusUnknown || ErrorCode(err) != "ambiguous_delivery" || !strings.Contains(r.Detail, "bounded scan") {
		t.Fatalf("scan failure was reported as successful admission: %+v %v", r, err)
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
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
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
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
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
				io.Copy(io.Discard, c) // stay connected: macOS has no peer PID after close
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

// macOS puts Claude's cc-socks dir under a long $TMPDIR; the receipt socket
// must still bind beside the receiver's socket, in the name shape Claude
// accepts for peers.
func TestClaudeNativePolicyReceiptUnderLongTMPDIR(t *testing.T) {
	long := filepath.Join(socketTempDir(t), strings.Repeat("d", 45))
	if err := os.Mkdir(long, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMPDIR", long)
	var from string
	req, _ := nativeClaudeFixture(t, func(frame map[string]any, f *os.File) {
		reg, _ := readClaudeNative("session")
		from = strings.TrimPrefix(frame["from"].(string), "uds:")
		c, err := net.Dial("unix", from)
		if err != nil {
			return
		}
		defer c.Close()
		json.NewEncoder(c).Encode(map[string]any{"type": "control", "action": "peer_message_status", "status": "denied", "from": "uds:" + reg.Socket, "orig_msg_id": frame["msg_id"]})
		io.Copy(io.Discard, c) // stay connected: macOS has no peer PID after close
	})
	reg, _ := readClaudeNative("session")
	if old := filepath.Join(filepath.Dir(reg.Socket), fmt.Sprintf("shuttle-%d-%012x.sock", os.Getpid(), 0)); len(old) <= maxUnixSocketPath {
		t.Fatalf("fixture dir too short to exercise the limit: %d bytes", len(old))
	}
	r, err := Send(context.Background(), "host", req)
	if err == nil || r.Status != StatusRejected || !strings.Contains(r.Detail, "denied") {
		t.Fatalf("%+v %v", r, err)
	}
	if filepath.Dir(from) != filepath.Dir(reg.Socket) || !regexp.MustCompile(`^[0-9a-f]{6,16}\.sock$`).MatchString(filepath.Base(from)) || len(from) > maxUnixSocketPath {
		t.Fatalf("receipt socket %q", from)
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
		io.Copy(io.Discard, c) // stay connected: macOS has no peer PID after close
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
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
		io.Copy(io.Discard, c) // stay connected: macOS has no peer PID after close
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
