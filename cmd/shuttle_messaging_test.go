package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/messaging"
)

func TestReadMessageRequestFrameReturnsAtNewline(t *testing.T) {
	reader, writer := io.Pipe()
	done := make(chan struct{})
	var (
		got messaging.Request
		err error
	)
	go func() {
		got, err = readMessageRequestFrame(reader)
		close(done)
	}()
	frame := `{"address":"shuttle://host/codex/native%2Fid","text":"line 1\n$(touch /tmp/nope); ` + "`uname`" + `","from":"codex-thread:abc","wake":true,"message_id":"msg-1"}` + "\n"
	if _, err := io.WriteString(writer, frame); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("request reader waited for EOF after receiving a complete frame")
	}
	_ = writer.Close()
	if err != nil {
		t.Fatal(err)
	}
	if got.Text != "line 1\n$(touch /tmp/nope); `uname`" || got.MessageID != "msg-1" || !got.Wake {
		t.Fatalf("request changed in transit: %#v", got)
	}
}

func TestReadMessageRequestFrameRejectsTrailingJSON(t *testing.T) {
	_, err := readMessageRequestFrame(strings.NewReader(`{"address":"shuttle://host/codex/id","text":"hi","message_id":"one"} {"message_id":"two"}` + "\n"))
	if err == nil || !strings.Contains(err.Error(), "trailing JSON value") {
		t.Fatalf("expected trailing JSON error, got %v", err)
	}
}

func TestPostMessagePreservesRequestAndReceipt(t *testing.T) {
	want := messaging.Request{Address: "shuttle://host/codex/native%2Fid", Text: "a\n'b; $(noop)", From: "external", Wake: true, MessageID: "msg-fixed"}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/messages" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		var got messaging.Request
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Errorf("request mismatch:\n got %#v\nwant %#v", got, want)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(messaging.Receipt{MessageID: got.MessageID, Address: got.Address, Status: messaging.StatusSubmitted, Transport: "codex"})
	}))
	defer server.Close()
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)

	got, err := postMessage(want)
	if err != nil {
		t.Fatal(err)
	}
	if got.MessageID != want.MessageID || got.Status != messaging.StatusSubmitted || got.Address != want.Address {
		t.Fatalf("receipt mismatch: %#v", got)
	}
}

func TestPostMessageReturnsNon2xxReceipt(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(messaging.Receipt{MessageID: "msg-1", Address: "shuttle://host/codex/id", Status: messaging.StatusRejected, Transport: "dedup", Detail: "message_id conflict"})
	}))
	defer server.Close()
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)

	receipt, err := postMessage(messaging.Request{MessageID: "msg-1", Address: "shuttle://host/codex/id"})
	if err == nil {
		t.Fatal("expected non-2xx error")
	}
	if receipt.Status != messaging.StatusRejected || receipt.MessageID != "msg-1" {
		t.Fatalf("non-2xx receipt was lost: %#v", receipt)
	}
}

func TestPostMessageDiscardsUncorrelatedReceipts(t *testing.T) {
	for _, status := range []int{200, 400, 502} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(status)
				_ = json.NewEncoder(w).Encode(messaging.Receipt{MessageID: "other", Address: "shuttle://host/codex/other", Status: messaging.StatusAccepted, Transport: "codex"})
			}))
			defer server.Close()
			t.Setenv("SHUTTLE_DAEMON_URL", server.URL)
			receipt, err := postMessage(messaging.Request{MessageID: "requested", Address: "shuttle://host/codex/requested"})
			if err == nil || receipt != (messaging.Receipt{}) {
				t.Fatalf("unrelated receipt retained: %#v, %v", receipt, err)
			}
		})
	}
}

func TestResolveMessageSenderIsReplyAddress(t *testing.T) {
	t.Setenv("SHUTTLE_HOST", "sender")
	t.Setenv("CODEX_THREAD_ID", "thread/id")
	if got := resolveMessageSender(""); got != "shuttle://sender/codex/thread%2Fid" {
		t.Fatalf("sender = %q", got)
	}
	if got := resolveMessageSender("explicit"); got != "explicit" {
		t.Fatalf("explicit sender = %q", got)
	}
}

func TestFilterPeerDirectoryAppliesHostAndHarness(t *testing.T) {
	directory := messaging.Directory{
		Host: "hub",
		Sessions: []messaging.Session{
			{Address: "shuttle://b/codex/2", Host: "b", Harness: "codex"},
			{Address: "shuttle://a/codex/1", Host: "a", Harness: "codex"},
			{Address: "shuttle://a/claude/3", Host: "a", Harness: "claude"},
		},
		Gaps: []messaging.Gap{{Host: "a", Harness: "codex", Error: "down"}, {Host: "b", Harness: "codex", Error: "down"}},
	}
	got := filterPeerDirectory(directory, "a", "codex")
	if len(got.Sessions) != 1 || got.Sessions[0].Address != "shuttle://a/codex/1" {
		t.Fatalf("unexpected sessions: %#v", got.Sessions)
	}
	if len(got.Gaps) != 1 || got.Gaps[0].Host != "a" {
		t.Fatalf("unexpected gaps: %#v", got.Gaps)
	}
}
