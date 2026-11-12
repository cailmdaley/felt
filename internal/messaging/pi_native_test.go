package messaging

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func FuzzPiNativeReply(f *testing.F) {
	for _, seed := range []string{
		`{"ok":true,"queued":true,"requestId":"request","sessionId":"session","delivery":"steer"}`,
		`{"ok":true,"requestId":"request","sessionId":"session","delivery":"follow_up"}`,
		`{"ok":true,"requestId":"request","sessionId":"session","delivery":"steer"}`,
		`{"ok":false,"requestId":"request","sessionId":"session","error":"refused"}`,
		`{"requestId":"request","sessionId":"session","error":"unconfirmed"}`,
		`{"ok":true,"requestId":"other","sessionId":"session","delivery":"steer"}`,
		`null`, `{`,
	} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		req := Request{Address: "shuttle://host/pi/session", MessageID: "message"}
		receipt, err := decodePiNativeReply(data, "request", "session", req)
		if receipt.Address != req.Address || receipt.MessageID != req.MessageID || receipt.Transport != piNativeTransport {
			t.Fatalf("reply changed routing identity: %#v", receipt)
		}
		switch receipt.Status {
		case StatusAccepted, StatusQueued, StatusRejected:
			var evidence piNativeReply
			if json.Unmarshal(data, &evidence) != nil || evidence.RequestID != "request" || evidence.SessionID != "session" || evidence.OK == nil {
				t.Fatalf("uncorrelated evidence produced definitive receipt: %#v", receipt)
			}
			if receipt.Status == StatusAccepted || receipt.Status == StatusQueued {
				if err != nil || !*evidence.OK || (evidence.Delivery != "steer" && evidence.Delivery != "follow_up") {
					t.Fatalf("accepted without native admission evidence: %#v", receipt)
				}
			} else if err == nil || *evidence.OK {
				t.Fatalf("rejected without explicit native refusal: %#v", receipt)
			}
		case StatusUnknown:
			if err == nil {
				t.Fatal("unknown delivery must report an error")
			}
		default:
			t.Fatalf("unexpected native receipt status: %#v", receipt)
		}
	})
}

func piNativeFixture(t *testing.T, reply any) (string, func()) {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "felt-pi-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	socket := filepath.Join(dir, "worker.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(socket, 0600); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			request := map[string]any{}
			if err := json.NewDecoder(bufio.NewReader(conn)).Decode(&request); err != nil {
				_ = conn.Close()
				continue // discovery liveness probes intentionally send no frame
			}
			response := reply
			if fn, ok := reply.(func(map[string]any) any); ok {
				response = fn(request)
			}
			if response != nil {
				_ = json.NewEncoder(conn).Encode(response)
			}
			_ = conn.Close()
		}
	}()
	return socket, func() {
		_ = listener.Close()
		<-done
	}
}

func TestPiNativeHeaderHasExactSenderAndFiberReplyTarget(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	seen := make(chan map[string]any, 1)
	socket, closeFixture := piNativeFixture(t, func(frame map[string]any) any {
		seen <- frame
		return map[string]any{"ok": true, "requestId": frame["requestId"], "sessionId": frame["sessionId"], "delivery": "follow_up"}
	})
	defer closeFixture()
	if err := RegisterPiNative(env, "session", "host", "/project", socket, "", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	req := Request{Address: "shuttle://host/pi/session", Text: "hello", MessageID: "pi-header", Wake: true, From: "shuttle://peer/pi/A", ReplyTo: "work/fiber"}
	receipt, err := Send(context.Background(), env, "host", req)
	if err != nil || receipt.Status != StatusAccepted {
		t.Fatalf("%#v %v", receipt, err)
	}
	if frame := <-seen; frame["message"] != "[from work/fiber]\nhello" {
		t.Fatalf("header: %#v", frame)
	}
}

func TestPiNativeRegistrationAndDiscovery(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	socket, closeFixture := piNativeFixture(t, map[string]any{"ok": true})
	defer closeFixture()
	if err := RegisterMailbox(env, "pi", "session", "host", "/project", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	if err := RegisterPiNative(env, "session", "host", "/project", socket, "", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	// A launcher alias must not duplicate the same live native conversation.
	jobs := filepath.Join(env.Getenv("SHUTTLE_CONFER_STATE_DIR"), "workspace", "jobs")
	if err := os.MkdirAll(jobs, 0700); err != nil {
		t.Fatal(err)
	}
	job, err := json.Marshal(map[string]any{"id": "job-alias", "sessionId": "session", "socketPath": socket})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(jobs, "job-alias.json"), job, 0600); err != nil {
		t.Fatal(err)
	}
	sessions, err := (piAdapter{}).discover(context.Background(), env, "host")
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || sessions[0].CWD != "/project" || sessions[0].State != "unknown" {
		t.Fatalf("sessions: %#v", sessions)
	}
	if err := RegisterPiNative(env, "session", "host", "/project", socket, "/tmp/session.jsonl", os.Getpid(), false); err != nil {
		t.Fatal(err)
	}
	if piNativeAvailable(env, "session", "host") {
		t.Fatal("native registration survived shutdown")
	}
}

func TestPiNativeRegistrationReplacesDeadSameSessionSocket(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir := socketTempDir(t)
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	oldSocket := filepath.Join(dir, "old-worker.sock")
	oldListener, err := net.Listen("unix", oldSocket)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(oldSocket, 0600); err != nil {
		t.Fatal(err)
	}
	oldListener.(*net.UnixListener).SetUnlinkOnClose(false)
	if err := RegisterPiNative(env, "session", "host", "/project", oldSocket, "", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	if err := oldListener.Close(); err != nil {
		t.Fatal(err)
	}
	if !piNativeAvailable(env, "session", "host") {
		t.Fatal("stale socket should retain its filesystem identity until the replacement starts")
	}
	if sessions := piNativeSessions(env, "host"); len(sessions) != 0 {
		t.Fatalf("dead Pi socket remained discoverable: %#v", sessions)
	}

	newSocket := filepath.Join(dir, "new-worker.sock")
	newListener, err := net.Listen("unix", newSocket)
	if err != nil {
		t.Fatal(err)
	}
	defer newListener.Close()
	if err := os.Chmod(newSocket, 0600); err != nil {
		t.Fatal(err)
	}
	if err := RegisterPiNative(env, "session", "host", "/project", newSocket, "", os.Getpid()+1, true); err != nil {
		t.Fatalf("new receiver could not replace the dead receiver: %v", err)
	}
	registration, err := readPiNative(env, "session")
	if err != nil || registration.Socket != newSocket {
		t.Fatalf("registration=%#v err=%v", registration, err)
	}
}

func TestPiNativeSendCorrelatesSessionAndRequest(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		reply  map[string]any
		status string
		code   string
	}{
		{"accepted", map[string]any{"ok": true, "delivery": "follow_up", "requestId": "", "sessionId": ""}, StatusAccepted, ""},
		{"rejected", map[string]any{"ok": false, "error": "busy", "requestId": "", "sessionId": ""}, StatusRejected, "native_rejected"},
		{"missing ok", map[string]any{"delivery": "follow_up", "requestId": "", "sessionId": ""}, StatusUnknown, "ambiguous_delivery"},
		{"wrong request", map[string]any{"ok": true, "delivery": "follow_up", "requestId": "wrong", "sessionId": "session"}, StatusUnknown, "ambiguous_delivery"},
		{"wrong session", map[string]any{"ok": true, "delivery": "follow_up", "requestId": "", "sessionId": "wrong"}, StatusUnknown, "ambiguous_delivery"},
		{"wrong delivery", map[string]any{"ok": true, "delivery": "queued", "requestId": "", "sessionId": "session"}, StatusUnknown, "ambiguous_delivery"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			socket, closeFixture := piNativeFixture(t, func(request map[string]any) any {
				requestID, _ := request["requestId"].(string)
				if tc.reply["requestId"] == "" {
					tc.reply["requestId"] = requestID
				}
				if tc.reply["sessionId"] == "" {
					tc.reply["sessionId"] = request["sessionId"]
				}
				return tc.reply
			})
			defer closeFixture()
			if err := RegisterPiNative(env, "session", "host", "/project", socket, filepath.Join(t.TempDir(), "session.jsonl"), os.Getpid(), true); err != nil {
				t.Fatal(err)
			}
			req := Request{Address: "shuttle://host/pi/session", Text: "hello", MessageID: "native", Wake: true}
			// The reply alone decides the receipt: the transcript that could
			// confirm an ambiguous reply is never written, so no observation
			// window is spent waiting for it.
			receipt, err, _ := sendPiNativeWithDedupMetadata(context.Background(), env, Address{Host: "host", Harness: "pi", ID: "session"}, req, 0)
			codeMatches := (tc.code == "" && err == nil) || (tc.code != "" && ErrorCode(err) == tc.code)
			if receipt.Status != tc.status || !codeMatches {
				t.Fatalf("receipt=%#v err=%v", receipt, err)
			}
		})
	}
}

func TestPiMailboxSupportsPassiveContext(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	if err := RegisterMailbox(env, "pi", "session", "host", "/project", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	req := Request{Address: "shuttle://host/pi/session", Text: "context", MessageID: "passive"}
	receipt, err := Send(context.Background(), env, "host", req)
	if err != nil || receipt.Status != StatusQueued || receipt.Transport != "pi-hook" {
		t.Fatalf("send: %#v %v", receipt, err)
	}
	var offered []Request
	if err := OfferMailbox(env, "pi", "session", "host", func(requests []Request) error { offered = requests; return nil }); err != nil {
		t.Fatal(err)
	}
	if len(offered) != 1 || offered[0].Text != "context" || strings.Contains(offered[0].Text, "base64") {
		t.Fatalf("offered: %#v", offered)
	}
}

func TestPiNativeTranscriptReceipts(t *testing.T) {
	for _, scenario := range []string{"idle", "mid-turn", "concurrent", "unrelated", "historical", "wrong-session", "assistant"} {
		t.Run(scenario, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			transcript := filepath.Join(t.TempDir(), "session.jsonl")
			id := "session"
			if scenario == "wrong-session" {
				id = "other"
			}
			header, _ := json.Marshal(map[string]any{"type": "session", "id": id})
			os.WriteFile(transcript, append(header, '\n'), 0600)
			req := Request{Address: "shuttle://host/pi/session", Text: "same body", MessageID: "first", Wake: true}
			var mu sync.Mutex
			appendMessage := func(text, role string) {
				mu.Lock()
				defer mu.Unlock()
				row, _ := json.Marshal(map[string]any{"type": "message", "message": map[string]any{"role": role, "content": []map[string]string{{"type": "text", "text": text}}}})
				f, err := os.OpenFile(transcript, os.O_APPEND|os.O_WRONLY, 0600)
				if err != nil {
					t.Error(err)
					return
				}
				defer f.Close()
				f.Write(append(row, '\n'))
			}
			if scenario == "historical" {
				appendMessage(labeled(req), "user")
			}
			socket, closeFixture := piNativeFixture(t, func(frame map[string]any) any {
				text := frame["message"].(string)
				switch scenario {
				case "mid-turn":
					time.Sleep(75 * time.Millisecond)
					appendMessage(text, "user")
				case "idle", "wrong-session":
					appendMessage(text, "user")
				case "concurrent":
					if strings.Contains(text, req.Text) {
						appendMessage(text, "user")
					}
				case "unrelated":
					appendMessage("other activity", "user")
				case "assistant":
					appendMessage(text, "assistant")
				}
				// The extension cannot establish admission from its void API call.
				return map[string]any{"requestId": frame["requestId"], "sessionId": frame["sessionId"], "delivery": "steer"}
			})
			defer closeFixture()
			if err := RegisterPiNative(env, "session", "host", "/project", socket, transcript, os.Getpid(), true); err != nil {
				t.Fatal(err)
			}
			send := func(r Request) Receipt {
				ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
				defer cancel()
				receipt, _ := sendPiNative(ctx, env, Address{Host: "host", Harness: "pi", ID: "session"}, r)
				return receipt
			}
			if scenario == "concurrent" {
				other := req
				other.MessageID = "second"
				other.Text = "other body"
				done := make(chan Receipt, 1)
				go func() { done <- send(other) }()
				first := send(req)
				second := <-done
				if first.Status != StatusAccepted || second.Status != StatusUnknown {
					t.Fatalf("first=%+v second=%+v", first, second)
				}
				return
			}
			want := StatusUnknown
			if scenario == "idle" || scenario == "mid-turn" {
				want = StatusAccepted
			}
			if got := send(req); got.Status != want {
				t.Fatalf("receipt=%+v want=%s", got, want)
			}
		})
	}
}

func TestPiNativeQueuedRefreshAfterObservationDeadline(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	transcript := filepath.Join(t.TempDir(), "session.jsonl")
	if err := os.WriteFile(transcript, []byte(`{"type":"session","id":"session"}`+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	var sends atomic.Int32
	socket, closeFixture := piNativeFixture(t, func(frame map[string]any) any {
		sends.Add(1)
		return map[string]any{"requestId": frame["requestId"], "sessionId": frame["sessionId"], "delivery": "steer", "ok": true, "queued": true}
	})
	defer closeFixture()
	if err := RegisterPiNative(env, "session", "host", "/project", socket, transcript, os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	req := Request{Address: "shuttle://host/pi/session", MessageID: "held-steer", Text: "one task", Wake: true}
	first, err := withDedup(context.Background(), env, req, func(ctx context.Context) dedupSendResult {
		receipt, err, metadata := sendPiNativeWithDedupMetadata(ctx, env, Address{Host: "host", Harness: "pi", ID: "session"}, req, 50*time.Millisecond)
		return dedupSendResult{Receipt: receipt, Err: err, Metadata: metadata}
	})
	if err != nil || first.Status != StatusQueued {
		t.Fatalf("queued receipt=%+v err=%v", first, err)
	}
	time.Sleep(50 * time.Millisecond) // The steer remains held past the observation deadline.
	readCtx, cancelRead := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancelRead()
	pending, err := Send(readCtx, env, "host", req)
	if err != nil || pending.Status != StatusQueued {
		t.Fatalf("pending receipt=%+v err=%v", pending, err)
	}
	appendPiUserRow(t, transcript, labeled(req))
	for i := 0; i < 2; i++ {
		admitted, err := Send(context.Background(), env, "host", req)
		if err != nil || admitted.Status != StatusAccepted {
			t.Fatalf("admitted receipt=%+v err=%v", admitted, err)
		}
	}
	if got := sends.Load(); got != 1 {
		t.Fatalf("message was sent %d times", got)
	}
}

func TestPiNativeQueueNeedsReplyAndTranscript(t *testing.T) {
	for _, scenario := range []string{"dropped socket", "no session"} {
		t.Run(scenario, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			var reply any
			transcript := ""
			if scenario == "dropped socket" {
				transcript = filepath.Join(t.TempDir(), "session.jsonl")
				if err := os.WriteFile(transcript, []byte(`{"type":"session","id":"session"}`+"\n"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "no session" {
				reply = func(frame map[string]any) any {
					return map[string]any{"requestId": frame["requestId"], "sessionId": frame["sessionId"], "ok": true, "queued": true, "delivery": "steer"}
				}
			}
			socket, closeFixture := piNativeFixture(t, reply)
			defer closeFixture()
			if err := RegisterPiNative(env, "session", "host", "/project", socket, transcript, os.Getpid(), true); err != nil {
				t.Fatal(err)
			}
			req := Request{Address: "shuttle://host/pi/session", MessageID: "no-evidence", Text: "task", Wake: true}
			ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
			defer cancel()
			receipt, err := sendPiNative(ctx, env, Address{Host: "host", Harness: "pi", ID: "session"}, req)
			if receipt.Status != StatusUnknown || ErrorCode(err) != "ambiguous_delivery" {
				t.Fatalf("receipt=%+v err=%v", receipt, err)
			}
		})
	}
}

func appendPiUserRow(t *testing.T, path, text string) {
	t.Helper()
	row, err := json.Marshal(map[string]any{"type": "message", "message": map[string]any{"role": "user", "content": []map[string]string{{"type": "text", "text": text}}}})
	if err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.Write(append(row, '\n')); err != nil {
		t.Fatal(err)
	}
}

func TestPiReceiptSkipsOversizedTranscriptRow(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "session.jsonl")
	if err := os.WriteFile(path, []byte(`{"type":"session","id":"session"}`+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	f := openPiReceiptTranscript(path, "session")
	if f == nil {
		t.Fatal("cannot open transcript")
	}
	defer f.Close()
	appendPiUserRow(t, path, strings.Repeat("x", 4<<20))
	appendPiUserRow(t, path, "expected message")
	if !observePiReceipt(context.Background(), f, path, "session", nativeContentHash("expected message"), time.Now().Add(100*time.Millisecond)) {
		t.Fatal("oversized unrelated row hid the admitted message")
	}
}

func TestPiReceiptWaitsForSessionHeader(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "session.jsonl")
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		time.Sleep(20 * time.Millisecond)
		if err := os.WriteFile(path, []byte(`{"type":"session","id":"session"}`+"\n"), 0600); err != nil {
			t.Error(err)
			return
		}
		appendPiUserRow(t, path, "expected message")
	}()
	observed := observePiReceipt(context.Background(), nil, path, "session", nativeContentHash("expected message"), time.Now().Add(200*time.Millisecond))
	<-done
	if !observed {
		t.Fatal("empty session file was mistaken for a missing header")
	}
}
