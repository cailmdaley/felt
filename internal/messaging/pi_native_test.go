package messaging

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func FuzzPiNativeReply(f *testing.F) {
	for _, seed := range []string{
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
		case StatusAccepted, StatusRejected:
			var evidence piNativeReply
			if json.Unmarshal(data, &evidence) != nil || evidence.RequestID != "request" || evidence.SessionID != "session" || evidence.OK == nil {
				t.Fatalf("uncorrelated evidence produced definitive receipt: %#v", receipt)
			}
			if receipt.Status == StatusAccepted {
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
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		request := map[string]any{}
		_ = json.NewDecoder(bufio.NewReader(conn)).Decode(&request)
		if fn, ok := reply.(func(map[string]any) any); ok {
			reply = fn(request)
		}
		_ = json.NewEncoder(conn).Encode(reply)
	}()
	return socket, func() {
		_ = listener.Close()
		<-done
	}
}

func TestPiNativeRegistrationAndDiscovery(t *testing.T) {
	t.Setenv("SHUTTLE_DATA_DIR", t.TempDir())
	t.Setenv("SHUTTLE_CONFER_STATE_DIR", t.TempDir())
	socket, closeFixture := piNativeFixture(t, map[string]any{"ok": true})
	defer closeFixture()
	if err := RegisterMailbox("pi", "session", "host", "/project", true); err != nil {
		t.Fatal(err)
	}
	if err := RegisterPiNative("session", "host", "/project", socket, "", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	// A launcher alias must not duplicate the same live native conversation.
	jobs := filepath.Join(os.Getenv("SHUTTLE_CONFER_STATE_DIR"), "workspace", "jobs")
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
	sessions, err := (piAdapter{}).discover(context.Background(), "host")
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || sessions[0].CWD != "/project" || sessions[0].State != "unknown" {
		t.Fatalf("sessions: %#v", sessions)
	}
	if err := RegisterPiNative("session", "host", "/project", socket, "/tmp/session.jsonl", os.Getpid(), false); err != nil {
		t.Fatal(err)
	}
	if piNativeAvailable("session", "host") {
		t.Fatal("native registration survived shutdown")
	}
}

func TestPiNativeRegistrationReplacesDeadSameSessionSocket(t *testing.T) {
	t.Setenv("SHUTTLE_DATA_DIR", t.TempDir())
	dir := t.TempDir()
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
	if err := RegisterPiNative("session", "host", "/project", oldSocket, "", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	if err := oldListener.Close(); err != nil {
		t.Fatal(err)
	}
	if !piNativeAvailable("session", "host") {
		t.Fatal("stale socket should retain its filesystem identity until the replacement starts")
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
	if err := RegisterPiNative("session", "host", "/project", newSocket, "", os.Getpid()+1, true); err != nil {
		t.Fatalf("new receiver could not replace the dead receiver: %v", err)
	}
	registration, err := readPiNative("session")
	if err != nil || registration.Socket != newSocket {
		t.Fatalf("registration=%#v err=%v", registration, err)
	}
}

func TestPiNativeSendCorrelatesSessionAndRequest(t *testing.T) {
	t.Setenv("SHUTTLE_DATA_DIR", t.TempDir())
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
			t.Setenv("SHUTTLE_DATA_DIR", t.TempDir())
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
			if err := RegisterPiNative("session", "host", "/project", socket, "/tmp/session.jsonl", os.Getpid(), true); err != nil {
				t.Fatal(err)
			}
			req := Request{Address: "shuttle://host/pi/session", Text: "hello", MessageID: "native", Wake: true}
			receipt, err := sendPiNative(context.Background(), Address{Host: "host", Harness: "pi", ID: "session"}, req)
			codeMatches := (tc.code == "" && err == nil) || (tc.code != "" && ErrorCode(err) == tc.code)
			if receipt.Status != tc.status || !codeMatches {
				t.Fatalf("receipt=%#v err=%v", receipt, err)
			}
		})
	}
}

func TestPiMailboxSupportsPassiveContext(t *testing.T) {
	t.Setenv("SHUTTLE_DATA_DIR", t.TempDir())
	if err := RegisterMailbox("pi", "session", "host", "/project", true); err != nil {
		t.Fatal(err)
	}
	req := Request{Address: "shuttle://host/pi/session", Text: "context", MessageID: "passive"}
	receipt, err := Send(context.Background(), "host", req)
	if err != nil || receipt.Status != StatusQueued || receipt.Transport != "pi-hook" {
		t.Fatalf("send: %#v %v", receipt, err)
	}
	var offered []Request
	if err := OfferMailbox("pi", "session", "host", func(requests []Request) error { offered = requests; return nil }); err != nil {
		t.Fatal(err)
	}
	if len(offered) != 1 || offered[0].Text != "context" || strings.Contains(offered[0].Text, "base64") {
		t.Fatalf("offered: %#v", offered)
	}
}
