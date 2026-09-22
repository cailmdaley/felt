package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
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

func TestBuildAttachmentOnlyMessage(t *testing.T) {
	oldFiles, oldID, oldFrom, oldFile := messageAttachments, messageID, messageFrom, messageFile
	t.Cleanup(func() { messageAttachments, messageID, messageFrom, messageFile = oldFiles, oldID, oldFrom, oldFile })
	path := filepath.Join(t.TempDir(), "bytes.bin")
	want := []byte{0, 255, 10, 128}
	if err := os.WriteFile(path, want, 0600); err != nil {
		t.Fatal(err)
	}
	messageAttachments, messageID, messageFrom, messageFile = []string{path}, "file-only", "sender", ""
	args := []string{"shuttle://host/codex/id"}
	if err := shuttleMessageCmd.Args(shuttleMessageCmd, args); err != nil {
		t.Fatal(err)
	}
	request, err := buildMessageRequest(strings.NewReader(""), args)
	if err != nil {
		t.Fatal(err)
	}
	if request.Text != "" || len(request.Attachments) != 1 || !reflect.DeepEqual(request.Attachments[0].Data, want) || request.Attachments[0].Name != "bytes.bin" {
		t.Fatalf("file-only message lost data: %+v", request)
	}
}

func TestBuildMessageRequestContextOnlyOptOut(t *testing.T) {
	oldWake, oldContextOnly := messageWake, messageContextOnly
	t.Cleanup(func() { messageWake, messageContextOnly = oldWake, oldContextOnly })
	messageWake, messageContextOnly = true, true

	request, err := buildMessageRequest(strings.NewReader("please read"), []string{"shuttle://host/codex/id"})
	if err != nil {
		t.Fatal(err)
	}
	if request.Wake {
		t.Fatal("--context-only should disable the active turn")
	}
}

func TestBuildMessageRequestDefaultsToWake(t *testing.T) {
	oldWake, oldContextOnly := messageWake, messageContextOnly
	t.Cleanup(func() { messageWake, messageContextOnly = oldWake, oldContextOnly })
	messageWake, messageContextOnly = true, false

	request, err := buildMessageRequest(strings.NewReader("please act"), []string{"shuttle://host/codex/id"})
	if err != nil {
		t.Fatal(err)
	}
	if !request.Wake {
		t.Fatal("ordinary messages should request an active turn")
	}
}

func TestMessageCobraWakeFlags(t *testing.T) {
	oldWake, oldContextOnly := messageWake, messageContextOnly
	wakeFlag := shuttleMessageCmd.Flags().Lookup("wake")
	contextOnlyFlag := shuttleMessageCmd.Flags().Lookup("context-only")
	oldWakeChanged, oldContextOnlyChanged := wakeFlag.Changed, contextOnlyFlag.Changed
	t.Cleanup(func() {
		messageWake, messageContextOnly = oldWake, oldContextOnly
		_ = shuttleMessageCmd.Flags().Set("wake", strconv.FormatBool(oldWake))
		_ = shuttleMessageCmd.Flags().Set("context-only", strconv.FormatBool(oldContextOnly))
		wakeFlag.Changed, contextOnlyFlag.Changed = oldWakeChanged, oldContextOnlyChanged
	})

	wake, err := shuttleMessageCmd.Flags().GetBool("wake")
	if err != nil {
		t.Fatal(err)
	}
	contextOnly, err := shuttleMessageCmd.Flags().GetBool("context-only")
	if err != nil {
		t.Fatal(err)
	}
	if !wake || contextOnly {
		t.Fatalf("unexpected message flag defaults: wake=%t context-only=%t", wake, contextOnly)
	}

	if err := shuttleMessageCmd.Flags().Set("context-only", "true"); err != nil {
		t.Fatal(err)
	}
	request, err := buildMessageRequest(strings.NewReader("context"), []string{"shuttle://host/codex/id"})
	if err != nil {
		t.Fatal(err)
	}
	if request.Wake {
		t.Fatal("--context-only should produce a context-only request")
	}

	if err := shuttleMessageCmd.Flags().Set("context-only", "false"); err != nil {
		t.Fatal(err)
	}
	if err := shuttleMessageCmd.Flags().Set("wake", "false"); err != nil {
		t.Fatal(err)
	}
	request, err = buildMessageRequest(strings.NewReader("context"), []string{"shuttle://host/codex/id"})
	if err != nil {
		t.Fatal(err)
	}
	if request.Wake {
		t.Fatal("--wake=false should produce a context-only request")
	}
}

func TestWakeRequiresExecutionAcknowledgement(t *testing.T) {
	for _, status := range []string{messaging.StatusQueued, messaging.StatusContextAdded, messaging.StatusSubmitted, messaging.StatusAccepted} {
		t.Run(status, func(t *testing.T) {
			request := messaging.Request{Address: "shuttle://host/codex/thread", MessageID: "wake-check", Wake: true}
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				_ = json.NewEncoder(w).Encode(messaging.Receipt{MessageID: request.MessageID, Address: request.Address, Status: status, Transport: "peer"})
			}))
			defer server.Close()
			t.Setenv("SHUTTLE_DAEMON_URL", server.URL)
			receipt, err := postMessage(request)
			if calls != 1 {
				t.Fatalf("wake retried automatically: %d", calls)
			}
			if status == messaging.StatusAccepted {
				if err != nil || receipt.Status != status {
					t.Fatalf("valid wake rejected: %+v %v", receipt, err)
				}
			} else if err == nil || !reflect.DeepEqual(receipt, messaging.Receipt{}) {
				t.Fatalf("context-only delivery counted as wake: %+v %v", receipt, err)
			}
		})
	}
}

func TestPostMessageFilesUsesVersionSafeRoute(t *testing.T) {
	path := filepath.Join(t.TempDir(), "image.bin")
	if err := os.WriteFile(path, []byte{0, 255, 13, 10}, 0600); err != nil {
		t.Fatal(err)
	}
	attachments, err := messaging.ReadAttachments([]string{path})
	if err != nil {
		t.Fatal(err)
	}
	request := messaging.Request{Address: "shuttle://host/codex/id", MessageID: "files", Attachments: attachments}
	for _, mode := range []string{"success", "old-daemon", "missing-files", "wrong-digest"} {
		t.Run(mode, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.URL.Path != "/api/v1/messages/files" {
					t.Errorf("unsafe route: %s", r.URL.Path)
				}
				var got messaging.Request
				if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
					t.Error(err)
					return
				}
				if !reflect.DeepEqual(got, request) {
					t.Errorf("binary payload changed: %+v", got)
				}
				if mode == "old-daemon" {
					w.WriteHeader(404)
					_, _ = io.WriteString(w, `{"error":"unsupported"}`)
					return
				}
				files := []messaging.ReceivedFile{{Name: attachments[0].Name, SHA256: attachments[0].SHA256, Size: int64(len(attachments[0].Data)), Path: "/receiver/files/image.bin"}}
				if mode == "missing-files" {
					files = nil
				}
				if mode == "wrong-digest" {
					files[0].SHA256 = strings.Repeat("0", 64)
				}
				_ = json.NewEncoder(w).Encode(messaging.Receipt{MessageID: request.MessageID, Address: request.Address, Status: messaging.StatusAccepted, Transport: "codex", Files: files})
			}))
			defer server.Close()
			t.Setenv("SHUTTLE_DAEMON_URL", server.URL)
			receipt, err := postMessage(request)
			if calls != 1 {
				t.Fatalf("unexpected fallback or retry: %d calls", calls)
			}
			if mode == "success" {
				if err != nil || len(receipt.Files) != 1 {
					t.Fatalf("attachment receipt: %+v %v", receipt, err)
				}
			} else if err == nil || !reflect.DeepEqual(receipt, messaging.Receipt{}) {
				t.Fatalf("unverified file delivery claimed: %+v %v", receipt, err)
			}
		})
	}
}

func TestReadMessageRequestFrameRejectsTrailingJSON(t *testing.T) {
	_, err := readMessageRequestFrame(strings.NewReader(`{"address":"shuttle://host/codex/id","text":"hi","message_id":"one"} {"message_id":"two"}` + "\n"))
	if err == nil || !strings.Contains(err.Error(), "trailing JSON value") {
		t.Fatalf("expected trailing JSON error, got %v", err)
	}
}

func TestReadMessageRequestFrameDefaultsWakeToTrue(t *testing.T) {
	request, err := readMessageRequestFrame(strings.NewReader(`{"address":"shuttle://host/codex/id","text":"work","message_id":"one"}` + "\n"))
	if err != nil {
		t.Fatal(err)
	}
	if !request.Wake {
		t.Fatal("omitted wake should request an active turn")
	}

	request, err = readMessageRequestFrame(strings.NewReader(`{"address":"shuttle://host/codex/id","text":"context","wake":false,"message_id":"two"}` + "\n"))
	if err != nil {
		t.Fatal(err)
	}
	if request.Wake {
		t.Fatal("explicit wake=false should preserve context-only delivery")
	}

	if _, err := readMessageRequestFrame(strings.NewReader(`{"address":"shuttle://host/codex/id","text":"invalid","wake":null}` + "\n")); err == nil {
		t.Fatal("wake=null should be rejected rather than treated as context-only")
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
		if !reflect.DeepEqual(got, want) {
			t.Errorf("request mismatch:\n got %#v\nwant %#v", got, want)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(messaging.Receipt{MessageID: got.MessageID, Address: got.Address, Status: messaging.StatusAccepted, Transport: "codex"})
	}))
	defer server.Close()
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)

	got, err := postMessage(want)
	if err != nil {
		t.Fatal(err)
	}
	if got.MessageID != want.MessageID || got.Status != messaging.StatusAccepted || got.Address != want.Address {
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
			if err == nil || !reflect.DeepEqual(receipt, messaging.Receipt{}) {
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
