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
	"regexp"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

func nativeClaudeFixture(t *testing.T, env *sysenv.Env, respond func(map[string]any, *os.File)) (Request, *atomic.Int32) {
	t.Helper()
	dir, err := os.MkdirTemp(env.Getenv("TMPDIR"), "felt-cn-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	env.Set("SHUTTLE_DATA_DIR", dir)
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
	if err := RegisterMailbox(env, "claude", "session", "host", dir, os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	if err := RegisterClaudeNative(env, "session", "host", dir, socket, transcript, true); err != nil {
		t.Fatal(err)
	}
	return Request{Address: "shuttle://host/claude/session", Text: "hello", From: "shuttle://peer/pi/sender", MessageID: "native-test", Wake: true}, &sent
}

// Mutation: remove reply metadata from the native content header. The wire
// `from` remains the UDS policy-receipt endpoint, not the human sender label.
func TestClaudeNativeHeaderHasExactSenderAndFiberReplyTarget(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	seen := make(chan map[string]any, 1)
	req, _ := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { seen <- frame; nativeRows(frame, f, false) })
	req.From = "shuttle://peer/pi/A"
	req.ReplyTo = "work/fiber"
	receipt, err := Send(context.Background(), env, "host", req)
	if err != nil || receipt.Status != StatusAccepted {
		t.Fatalf("%#v %v", receipt, err)
	}
	frame := <-seen
	if content := frame["message"].(map[string]any)["content"]; content != "[from work/fiber]\nhello" {
		t.Fatalf("header: %v", content)
	}
	if !strings.HasPrefix(frame["from"].(string), "uds:") {
		t.Fatalf("policy receipt endpoint lost: %#v", frame)
	}
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

// observationSettle is how long a test lets the sender's transcript observer
// (which rescans every 25ms) read what the receiver wrote before the test ends
// the observation window.
const observationSettle = 250 * time.Millisecond

// notify records that the receiver fixture has responded, at most once.
func notify(responded chan<- struct{}) {
	select {
	case responded <- struct{}{}:
	default:
	}
}

// sendUntilSettled sends req and ends its observation window once the
// receiver has responded and settle has passed, standing in for the
// observation timeout running out: the sender reports what it had observed by
// then, without the test waiting out the production window.
func sendUntilSettled(env *sysenv.Env, req Request, responded <-chan struct{}, settle time.Duration) (Receipt, error) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		select {
		case <-responded:
		case <-ctx.Done():
			return
		}
		timer := time.NewTimer(settle)
		defer timer.Stop()
		select {
		case <-timer.C:
			cancel()
		case <-ctx.Done():
		}
	}()
	return Send(ctx, env, "host", req)
}

func TestObserveClaudeTurnReportsFurthestObservedStage(t *testing.T) {
	t.Parallel()
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
			t.Parallel()
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
			stage, err := observeClaudeTurn(ctx, f, path, "session", uuid, nativeContentHash(content), nil)
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
	t.Parallel()
	env := testEnv(t)
	req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, false) })
	req.Attachments = []Attachment{{Name: "notes.bin", Data: []byte{0, 1, 255}}}
	// ReadAttachments owns digest generation; exercise the same public request path.
	file := filepath.Join(t.TempDir(), "notes.bin")
	os.WriteFile(file, []byte{0, 1, 255}, 0600)
	var err error
	req.Attachments, err = ReadAttachments(sysenv.New(t.TempDir(), nil), []string{file})
	if err != nil {
		t.Fatal(err)
	}
	r, err := Send(context.Background(), env, "host", req)
	if err != nil || r.Status != StatusAccepted || len(r.Files) != 1 {
		t.Fatalf("%+v %v", r, err)
	}
	retry, err := Send(context.Background(), env, "host", req)
	if err != nil || retry.Status != StatusAccepted || sent.Load() != 1 {
		t.Fatalf("retry %+v %v writes %d", retry, err, sent.Load())
	}
}

func TestClaudeNativeNoWakeAndUnknownRetry(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	responded := make(chan struct{}, 1)
	req, sent := nativeClaudeFixture(t, env, func(map[string]any, *os.File) { notify(responded) })
	req.Wake = false
	r, err := Send(context.Background(), env, "host", req)
	if err != nil || r.Status != StatusQueued || sent.Load() != 0 {
		t.Fatalf("%+v %v", r, err)
	}
	req.Wake = true
	req.MessageID = "wake-timeout"
	r, err = sendUntilSettled(env, req, responded, 0)
	if err == nil || r.Status != StatusUnknown {
		t.Fatalf("%+v %v", r, err)
	}
	// The retry answers the stored receipt and writes nothing.
	r, err = Send(context.Background(), env, "host", req)
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

// A wake whose first observation window saw nothing is confirmed by a later
// consume from the transcript alone, read from where it ended before the send,
// without writing to the socket again.
func TestConsumeConfirmsAClaudeBatchFromItsTranscript(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	frameCh := make(chan map[string]any, 1)
	_, sent := nativeClaudeFixture(t, env, func(frame map[string]any, _ *os.File) { frameCh <- frame })
	registration, err := readClaudeNative(env, "session")
	if err != nil {
		t.Fatal(err)
	}
	prefix := make([]byte, 9<<20)
	if err := os.WriteFile(registration.Transcript, prefix, 0600); err != nil {
		t.Fatal(err)
	}
	w := Worker{Address: "shuttle://host/claude/session", Epoch: transition(t, env, "session", "shuttle://host/claude/session")}
	if err := Enqueue(env, InboxEntry{Address: "fiber", Request: Request{MessageID: "m", Text: "hello"}, Wishes: Wishes{Turn: "force"}}); err != nil {
		t.Fatal(err)
	}
	brief := func(ctx context.Context, env *sysenv.Env, host string, r Request, address string) (Receipt, error) {
		ctx, cancel := context.WithTimeout(ctx, observationSettle)
		defer cancel()
		return sendFiberContextAttempt(ctx, env, host, r, address)
	}
	if _, err := consumeWith(context.Background(), env, "fiber", "host", w, brief); ErrorCode(err) != "ambiguous_delivery" {
		t.Fatalf("first send: %v", err)
	}
	root := mailboxDir(env, "fiber", "fiber")
	if batch := batchOf(t, root, "m"); batch == nil || batch.TranscriptOffset == nil || *batch.TranscriptOffset != int64(len(prefix)) || batch.status() != StatusUnknown {
		t.Fatalf("open batch = %+v", batch)
	}
	transcript, err := os.OpenFile(registration.Transcript, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	busyReceiverRows(<-frameCh, transcript, true)
	if err := transcript.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := consumeWith(context.Background(), env, "fiber", "host", w, neverSend(t)); err != nil {
		t.Fatal(err)
	}
	if n, _ := pendingCount(env, "fiber"); n != 0 || sent.Load() != 1 {
		t.Fatalf("pending = %d, socket writes = %d", n, sent.Load())
	}
}

// A consume reads an open batch's Claude transcript again and records what it
// shows, and keeps the receipt it has when the transcript cannot be read: its
// registration is gone, the transcript cannot be opened, the scan exceeds its
// bound, or the batch recorded no offset to read from.
func TestConsumeReobservesAClaudeBatch(t *testing.T) {
	for _, tc := range []struct {
		name, want string
	}{
		{"submitted", StatusSubmitted},
		{"registration gone", StatusUnknown},
		{"unopenable", StatusUnknown},
		{"scan bound", StatusUnknown},
		{"no offset", StatusUnknown},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			_, sent := nativeClaudeFixture(t, env, func(map[string]any, *os.File) {})
			const conversation = "shuttle://host/claude/session"
			w := Worker{Address: conversation, Epoch: transition(t, env, "session", conversation)}
			putWish(t, env, "m", "ask", "hold")
			root := mailboxDir(env, "fiber", "fiber")
			batch := newBatch(t, []string{filepath.Join(root, "pending", mailboxKey("m")+".json")}, conversation)
			offset := int64(0)
			batch.TranscriptOffset = &offset
			batch.Receipt = &Receipt{MessageID: batch.Payload.MessageID, Address: conversation, Status: StatusUnknown, Transport: claudeNativeTransport, Detail: "stored unknown"}
			batch.ErrorCode = "ambiguous_delivery"
			registration, err := readClaudeNative(env, "session")
			if err != nil {
				t.Fatal(err)
			}
			req := *batch.Payload
			req.Address = conversation
			transcript, err := os.OpenFile(registration.Transcript, os.O_APPEND|os.O_WRONLY, 0600)
			if err != nil {
				t.Fatal(err)
			}
			if tc.name == "no offset" {
				nativeRows(map[string]any{"uuid": claudeNativeUUID(req)}, transcript, false)
				batch.TranscriptOffset = nil
			} else if err := json.NewEncoder(transcript).Encode(map[string]any{"type": "user", "sessionId": "session", "uuid": claudeNativeUUID(req)}); err != nil {
				t.Fatal(err)
			}
			if err := transcript.Close(); err != nil {
				t.Fatal(err)
			}
			switch tc.name {
			case "registration gone":
				if err := os.Remove(filepath.Join(mailboxDir(env, "claude", "session"), "native.json")); err != nil {
					t.Fatal(err)
				}
			case "unopenable":
				if err := os.Remove(registration.Transcript); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(filepath.Join(t.TempDir(), "missing"), registration.Transcript); err != nil {
					t.Fatal(err)
				}
			case "scan bound":
				if err := os.WriteFile(registration.Transcript, make([]byte, 9<<20), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := writeBatch(root, &batch); err != nil {
				t.Fatal(err)
			}
			start := time.Now()
			if _, err := consumeWith(context.Background(), env, "fiber", "host", w, neverSend(t)); err == nil {
				t.Fatal("an unconfirmed batch answered no error")
			}
			got := batchOf(t, root, "m")
			if got == nil || got.status() != tc.want || sent.Load() != 0 || time.Since(start) > time.Second {
				t.Fatalf("batch = %+v, writes = %d, took %v", got, sent.Load(), time.Since(start))
			}
			if tc.want == StatusSubmitted && (got.ErrorCode != "" || strings.Contains(got.Receipt.Detail, dataDir(env))) {
				t.Fatalf("recorded stage = %+v", got)
			}
		})
	}
}

func TestClaudeNativeMidTurnAbsorptionIsAccepted(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	req, _ := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { busyReceiverRows(frame, f, true) })
	r, err := Send(context.Background(), env, "host", req)
	if err != nil || r.Status != StatusAccepted {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestClaudeNativeQueuedBehindTurnReportsQueueAdmission(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	responded := make(chan struct{}, 1)
	req, _ := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { busyReceiverRows(frame, f, false); notify(responded) })
	r, err := sendUntilSettled(env, req, responded, observationSettle)
	if err != nil || r.Status != StatusQueued || r.Detail != "queued behind the receiver's current turn; it runs when that turn ends" {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestClaudeNativeAbsorptionOfAnotherMessageIsNotEvidence(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	responded := make(chan struct{}, 1)
	req, _ := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) {
		frame["uuid"] = "another-message"
		frame["message"] = map[string]any{"content": "another message"}
		busyReceiverRows(frame, f, true)
		notify(responded)
	})
	r, err := sendUntilSettled(env, req, responded, observationSettle)
	if err == nil || r.Status != StatusUnknown || strings.Contains(r.Detail, "queued") {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestClaudeNativeSyntheticErrorIsNotStarted(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) { nativeRows(frame, f, true) })
	first, err := Send(context.Background(), env, "host", req)
	const detail = "the receiver took the message but its turn ended in an error without a model reply"
	if first.Status != StatusUnknown || first.Detail != detail || ErrorCode(err) != "receiver_turn_failed" {
		t.Fatalf("first receipt: %+v %v", first, err)
	}
	retry, err := Send(context.Background(), env, "host", req)
	if retry.Status != StatusUnknown || retry.Detail != detail || ErrorCode(err) != "receiver_turn_failed" || sent.Load() != 1 {
		t.Fatalf("retry upgraded a failed turn or resent: %+v %v writes=%d", retry, err, sent.Load())
	}
}

func TestClaudeNativeScanFailureAfterQueueIsUnknown(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	req, _ := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) {
		content := frame["message"].(map[string]any)["content"].(string)
		row := map[string]any{"type": "queue-operation", "operation": "enqueue", "sessionId": "session", "content": content}
		if err := json.NewEncoder(f).Encode(row); err != nil {
			return
		}
		_, _ = io.WriteString(f, strings.Repeat("x", 9<<20))
	})
	r, err := Send(context.Background(), env, "host", req)
	if r.Status != StatusUnknown || ErrorCode(err) != "ambiguous_delivery" || !strings.Contains(r.Detail, "bounded scan") {
		t.Fatalf("scan failure was reported as successful admission: %+v %v", r, err)
	}
}

func TestClaudeNativeReplacedSocketRefusesBeforeSend(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	req, sent := nativeClaudeFixture(t, env, func(map[string]any, *os.File) {})
	reg, _ := readClaudeNative(env, "session")
	reg.PID++
	b, _ := json.Marshal(reg)
	mailboxWrite(filepath.Join(mailboxDir(env, "claude", "session"), "native.json"), b, false)
	r, err := Send(context.Background(), env, "host", req)
	if ErrorCode(err) != "preflight_failed" || r.Status != StatusRejected || sent.Load() != 0 {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestClaudeNativeEvidenceIgnoresUnrelatedAndMalformed(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	responded := make(chan struct{}, 1)
	req, _ := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) {
		f.WriteString("not json\n")
		frame["uuid"] = "unrelated"
		nativeRows(frame, f, false)
		notify(responded)
	})
	r, err := sendUntilSettled(env, req, responded, observationSettle)
	if err == nil || r.Status != StatusUnknown {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestClaudeNativeRegistrationKeepsOneLiveOwner(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	_, _ = nativeClaudeFixture(t, env, func(map[string]any, *os.File) {})
	original, err := readClaudeNative(env, "session")
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
	if err := RegisterClaudeNative(env, "session", "host", "/", socket, original.Transcript, true); err == nil {
		t.Fatal("replaced live receiver")
	}
	current, _ := readClaudeNative(env, "session")
	if current.Socket != original.Socket {
		t.Fatalf("owner changed: %+v", current)
	}
	if err := RegisterClaudeNative(env, "session", "host", "/", socket, original.Transcript, false); err != nil {
		t.Fatal(err)
	}
	if !claudeNativeAvailable(env, "session", "host") {
		t.Fatal("other generation unregistered owner")
	}
	if err := RegisterClaudeNative(env, "session", "host", "/", original.Socket, original.Transcript, false); err != nil {
		t.Fatal(err)
	}
	if !claudeNativeAvailable(env, "session", "host") {
		t.Fatal("late SessionEnd withdrew live receiver")
	}
	if err := os.Remove(original.Socket); err != nil {
		t.Fatal(err)
	}
	if err := RegisterClaudeNative(env, "session", "host", "/", original.Socket, original.Transcript, false); err != nil {
		t.Fatal(err)
	}
	if _, err := readClaudeNative(env, "session"); !os.IsNotExist(err) {
		t.Fatalf("disconnected receiver still registered: %v", err)
	}
}

func TestClaudeNativeEvidenceRequiresExactSession(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	responded := make(chan struct{}, 1)
	req, _ := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) {
		uuid := frame["uuid"].(string)
		json.NewEncoder(f).Encode(map[string]any{"type": "user", "sessionId": "other-session", "uuid": uuid})
		json.NewEncoder(f).Encode(map[string]any{"type": "assistant", "sessionId": "session", "uuid": "assistant", "parentUuid": uuid, "message": map[string]any{"role": "assistant", "model": "claude-test"}})
		notify(responded)
	})
	r, err := sendUntilSettled(env, req, responded, observationSettle)
	if err == nil || r.Status != StatusUnknown {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestClaudeNativePolicyReceipts(t *testing.T) {
	t.Parallel()
	for _, status := range []string{"held", "denied", "expired", "refused", "dropped"} {
		t.Run(status, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			req, sent := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) {
				reg, _ := readClaudeNative(env, "session")
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
			r, err := Send(context.Background(), env, "host", req)
			expected := StatusRejected
			if status == "held" {
				expected = StatusUnknown
			}
			if err == nil || r.Status != expected || !strings.Contains(r.Detail, status) {
				t.Fatalf("%+v %v", r, err)
			}
			r, err = Send(context.Background(), env, "host", req)
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
	t.Parallel()
	env := testEnv(t)
	long := filepath.Join(socketTempDir(t), strings.Repeat("d", 45))
	if err := os.Mkdir(long, 0700); err != nil {
		t.Fatal(err)
	}
	env.Set("TMPDIR", long)
	var from string
	req, _ := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) {
		reg, _ := readClaudeNative(env, "session")
		from = strings.TrimPrefix(frame["from"].(string), "uds:")
		c, err := net.Dial("unix", from)
		if err != nil {
			return
		}
		defer c.Close()
		json.NewEncoder(c).Encode(map[string]any{"type": "control", "action": "peer_message_status", "status": "denied", "from": "uds:" + reg.Socket, "orig_msg_id": frame["msg_id"]})
		io.Copy(io.Discard, c) // stay connected: macOS has no peer PID after close
	})
	reg, _ := readClaudeNative(env, "session")
	if old := filepath.Join(filepath.Dir(reg.Socket), fmt.Sprintf("shuttle-%d-%012x.sock", os.Getpid(), 0)); len(old) <= maxUnixSocketPath {
		t.Fatalf("fixture dir too short to exercise the limit: %d bytes", len(old))
	}
	r, err := Send(context.Background(), env, "host", req)
	if err == nil || r.Status != StatusRejected || !strings.Contains(r.Detail, "denied") {
		t.Fatalf("%+v %v", r, err)
	}
	if filepath.Dir(from) != filepath.Dir(reg.Socket) || !regexp.MustCompile(`^[0-9a-f]{6,16}\.sock$`).MatchString(filepath.Base(from)) || len(from) > maxUnixSocketPath {
		t.Fatalf("receipt socket %q", from)
	}
}

func TestClaudeNativeRejectsUncorrelatedPolicyReceipt(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	responded := make(chan struct{}, 1)
	req, _ := nativeClaudeFixture(t, env, func(frame map[string]any, f *os.File) {
		reg, _ := readClaudeNative(env, "session")
		c, err := net.Dial("unix", strings.TrimPrefix(frame["from"].(string), "uds:"))
		if err != nil {
			return
		}
		defer c.Close()
		json.NewEncoder(c).Encode(map[string]any{"type": "control", "action": "peer_message_status", "status": "denied", "from": "uds:" + reg.Socket, "orig_msg_id": "wrong-id"})
		notify(responded)
		io.Copy(io.Discard, c) // stay connected: macOS has no peer PID after close
	})
	r, err := sendUntilSettled(env, req, responded, observationSettle)
	if err == nil || r.Status != StatusUnknown {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestClaudeNativeRegistrationDoesNotWaitForHeldLock(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	_, _ = nativeClaudeFixture(t, env, func(map[string]any, *os.File) {})
	reg, _ := readClaudeNative(env, "session")
	lock, err := os.OpenFile(filepath.Join(mailboxDir(env, "claude", "session"), "native.lock"), os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	done := make(chan error, 1)
	go func() { done <- RegisterClaudeNative(env, "session", "host", "/", reg.Socket, reg.Transcript, true) }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("registration ignored held lock")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("registration blocks its receiver hook")
	}
}

func TestClaudeNativeObservesFirstTranscriptCreation(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	req, _ := nativeClaudeFixture(t, env, func(frame map[string]any, _ *os.File) {
		reg, _ := readClaudeNative(env, "session")
		f, err := os.OpenFile(reg.Transcript, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			return
		}
		defer f.Close()
		nativeRows(frame, f, false)
	})
	reg, _ := readClaudeNative(env, "session")
	if err := os.Remove(reg.Transcript); err != nil {
		t.Fatal(err)
	}
	r, err := Send(context.Background(), env, "host", req)
	if err != nil || r.Status != StatusAccepted {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestClaudeNativeReceivesPolicyWithoutTranscript(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	req, _ := nativeClaudeFixture(t, env, func(frame map[string]any, _ *os.File) {
		reg, _ := readClaudeNative(env, "session")
		c, err := net.Dial("unix", strings.TrimPrefix(frame["from"].(string), "uds:"))
		if err != nil {
			return
		}
		defer c.Close()
		json.NewEncoder(c).Encode(map[string]any{"type": "control", "action": "peer_message_status", "status": "expired", "status_detail": "refused", "from": "uds:" + reg.Socket, "orig_msg_id": frame["msg_id"]})
		io.Copy(io.Discard, c) // stay connected: macOS has no peer PID after close
	})
	reg, _ := readClaudeNative(env, "session")
	if err := os.Remove(reg.Transcript); err != nil {
		t.Fatal(err)
	}
	r, err := Send(context.Background(), env, "host", req)
	if r.Status != StatusRejected || ErrorCode(err) != "wake_refused" {
		t.Fatalf("%+v %v", r, err)
	}
	if _, err := os.Stat(reg.Transcript); !os.IsNotExist(err) {
		t.Fatalf("adapter created transcript: %v", err)
	}
}

func TestClaudeNativeRefusesUnsafeTranscriptBeforeSend(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{"symlink", "fifo"} {
		t.Run(kind, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			req, sent := nativeClaudeFixture(t, env, func(map[string]any, *os.File) {})
			reg, _ := readClaudeNative(env, "session")
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
			r, err := Send(context.Background(), env, "host", req)
			if ErrorCode(err) != "preflight_failed" || r.Status != StatusRejected || sent.Load() != 0 {
				t.Fatalf("%+v %v writes %d", r, err, sent.Load())
			}
		})
	}
}
