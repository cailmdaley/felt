package shuttlecli

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/messaging"
)

type synchronizedMessageBuffer struct {
	mu sync.Mutex
	bytes.Buffer
}

func (b *synchronizedMessageBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.Buffer.Write(p)
}

func (b *synchronizedMessageBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.Buffer.String()
}

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
	oldFiles, oldID, oldFrom, oldFile := messageOpts.attachments, messageOpts.id, messageOpts.from, messageOpts.file
	t.Cleanup(func() {
		messageOpts.attachments, messageOpts.id, messageOpts.from, messageOpts.file = oldFiles, oldID, oldFrom, oldFile
	})
	path := filepath.Join(t.TempDir(), "bytes.bin")
	want := []byte{0, 255, 10, 128}
	if err := os.WriteFile(path, want, 0600); err != nil {
		t.Fatal(err)
	}
	messageOpts.attachments, messageOpts.id, messageOpts.from, messageOpts.file = []string{path}, "file-only", "sender", ""
	args := []string{"shuttle://host/codex/id"}
	if err := shuttleMessageCmd.Args(shuttleMessageCmd, args); err != nil {
		t.Fatal(err)
	}
	request, err := buildMessageRequest(strings.NewReader(""), args, &messageOpts)
	if err != nil {
		t.Fatal(err)
	}
	if request.Text != "" || len(request.Attachments) != 1 || !reflect.DeepEqual(request.Attachments[0].Data, want) || request.Attachments[0].Name != "bytes.bin" {
		t.Fatalf("file-only message lost data: %+v", request)
	}
}

func TestBuildMessageRequestContextOnlyOptOut(t *testing.T) {
	oldWake, oldContextOnly := messageOpts.wake, messageOpts.contextOnly
	t.Cleanup(func() { messageOpts.wake, messageOpts.contextOnly = oldWake, oldContextOnly })
	messageOpts.wake, messageOpts.contextOnly = true, true

	request, err := buildMessageRequest(strings.NewReader("please read"), []string{"shuttle://host/codex/id"}, &messageOpts)
	if err != nil {
		t.Fatal(err)
	}
	if request.Wake {
		t.Fatal("--context-only should disable the active turn")
	}
}

func TestBuildMessageRequestDefaultsToWake(t *testing.T) {
	oldWake, oldContextOnly := messageOpts.wake, messageOpts.contextOnly
	t.Cleanup(func() { messageOpts.wake, messageOpts.contextOnly = oldWake, oldContextOnly })
	messageOpts.wake, messageOpts.contextOnly = true, false

	request, err := buildMessageRequest(strings.NewReader("please act"), []string{"shuttle://host/codex/id"}, &messageOpts)
	if err != nil {
		t.Fatal(err)
	}
	if !request.Wake {
		t.Fatal("ordinary messages should request an active turn")
	}
}

func TestMessageCobraWakeFlags(t *testing.T) {
	oldWake, oldContextOnly := messageOpts.wake, messageOpts.contextOnly
	wakeFlag := shuttleMessageCmd.Flags().Lookup("wake")
	contextOnlyFlag := shuttleMessageCmd.Flags().Lookup("context-only")
	oldWakeChanged, oldContextOnlyChanged := wakeFlag.Changed, contextOnlyFlag.Changed
	t.Cleanup(func() {
		messageOpts.wake, messageOpts.contextOnly = oldWake, oldContextOnly
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
	request, err := buildMessageRequest(strings.NewReader("context"), []string{"shuttle://host/codex/id"}, &messageOpts)
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
	request, err = buildMessageRequest(strings.NewReader("context"), []string{"shuttle://host/codex/id"}, &messageOpts)
	if err != nil {
		t.Fatal(err)
	}
	if request.Wake {
		t.Fatal("--wake=false should produce a context-only request")
	}
}

func TestPostMessageNarrowsWakeReceiptStages(t *testing.T) {
	tests := []struct {
		name, status, transport string
		wake, accepted          bool
	}{
		{"native queued", messaging.StatusQueued, "claude-native", true, true},
		{"native submitted", messaging.StatusSubmitted, "claude-native", true, true},
		{"other queued", messaging.StatusQueued, "codex", true, false},
		{"other submitted", messaging.StatusSubmitted, "peer", true, false},
		{"context added for wake", messaging.StatusContextAdded, "codex", true, false},
		{"context added only", messaging.StatusContextAdded, "codex", false, true},
		{"accepted", messaging.StatusAccepted, "peer", true, true},
		{"unknown", messaging.StatusUnknown, "peer", true, true},
		{"rejected", messaging.StatusRejected, "peer", true, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			request := messaging.Request{Address: "shuttle://host/codex/thread", MessageID: "wake-check", Wake: tc.wake}
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				_ = json.NewEncoder(w).Encode(messaging.Receipt{MessageID: request.MessageID, Address: request.Address, Status: tc.status, Transport: tc.transport})
			}))
			defer server.Close()
			t.Setenv("SHUTTLE_DAEMON_URL", server.URL)
			receipt, err := postMessage(request)
			if calls != 1 {
				t.Fatalf("message retried automatically: %d", calls)
			}
			if tc.accepted {
				if err != nil || receipt.Status != tc.status {
					t.Fatalf("valid %s receipt rejected: %+v %v", tc.status, receipt, err)
				}
			} else if err == nil || !reflect.DeepEqual(receipt, messaging.Receipt{}) {
				t.Fatalf("invalid wake receipt retained: %+v %v", receipt, err)
			}
		})
	}
}

func TestMessageExitFollowsReceiptEvidence(t *testing.T) {
	for _, status := range []string{messaging.StatusAccepted, messaging.StatusSubmitted, messaging.StatusQueued, messaging.StatusContextAdded} {
		if err := messageReceiptError("message-id", messaging.Receipt{Status: status}, errors.New("stale transport error")); err != nil {
			t.Errorf("%s should exit successfully after a valid receipt: %v", status, err)
		}
	}
	for _, status := range []string{messaging.StatusRejected, messaging.StatusUnknown} {
		if err := messageReceiptError("message-id", messaging.Receipt{Status: status}, nil); err == nil {
			t.Errorf("%s should exit non-zero", status)
		}
	}
}

func TestMessageHelpDocumentsReceiptExitStatuses(t *testing.T) {
	for _, detail := range []string{"sending <message-id> to <resolved address>", "If interrupted, retry with", "Exit 0 means accepted, submitted, queued, or", "exit 1 means rejected, unknown"} {
		if !strings.Contains(shuttleMessageCmd.Long, detail) {
			t.Errorf("message help omits %q", detail)
		}
	}
}

func TestMessagePrintsRetryIDBeforePosting(t *testing.T) {
	oldID, oldFile, oldFrom := messageOpts.id, messageOpts.file, messageOpts.from
	oldWake, oldContextOnly, oldLocal, oldRequestJSON, oldJSON := messageOpts.wake, messageOpts.contextOnly, messageOpts.local, messageOpts.requestJSON, jsonOutput
	oldIn, oldOut, oldErr := shuttleMessageCmd.InOrStdin(), shuttleMessageCmd.OutOrStdout(), shuttleMessageCmd.ErrOrStderr()
	oldAttachments := messageOpts.attachments
	t.Cleanup(func() {
		messageOpts.id, messageOpts.file, messageOpts.from = oldID, oldFile, oldFrom
		messageOpts.wake, messageOpts.contextOnly, messageOpts.local, messageOpts.requestJSON, jsonOutput = oldWake, oldContextOnly, oldLocal, oldRequestJSON, oldJSON
		messageOpts.attachments = oldAttachments
		shuttleMessageCmd.SetIn(oldIn)
		shuttleMessageCmd.SetOut(oldOut)
		shuttleMessageCmd.SetErr(oldErr)
	})
	messageOpts.id, messageOpts.file, messageOpts.from = "msg-interrupted", "", "test sender"
	messageOpts.wake, messageOpts.contextOnly, messageOpts.local, messageOpts.requestJSON, jsonOutput = true, false, false, false, false
	var stderr synchronizedMessageBuffer
	shuttleMessageCmd.SetIn(strings.NewReader(""))
	shuttleMessageCmd.SetOut(io.Discard)
	shuttleMessageCmd.SetErr(&stderr)

	// The alias resolves before the announcement, so the printed and posted
	// address is the canonical one the retry and its dedup hash will use.
	input := "shuttle://host/claude-code/session"
	address := "shuttle://host/claude/session"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(stderr.String(), "sending msg-interrupted to "+address) {
			t.Errorf("request reached daemon before retry ID was printed: %q", stderr.String())
		}
		var request messaging.Request
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			return
		}
		if request.Address != address {
			t.Errorf("posted address = %q, want %q", request.Address, address)
		}
		_ = json.NewEncoder(w).Encode(messaging.Receipt{MessageID: request.MessageID, Address: request.Address, Status: messaging.StatusAccepted, Transport: "peer"})
	}))
	defer server.Close()
	t.Setenv("SHUTTLE_DAEMON_URL", server.URL)

	if err := shuttleMessageCmd.RunE(shuttleMessageCmd, []string{input, "hello"}); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(stderr.String(), "sending msg-interrupted to "+address+"\n") {
		t.Fatalf("announcement = %q", stderr.String())
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

// Claude Code exports CLAUDE_CODE_SESSION_ID; a Claude sender must get a
// reply address, not "external".
func TestResolveMessageSenderFromClaudeCodeSession(t *testing.T) {
	t.Setenv("SHUTTLE_HOST", "sender")
	t.Setenv("CODEX_THREAD_ID", "")
	t.Setenv("CLAUDE_SESSION_ID", "")
	t.Setenv("CLAUDE_CODE_SESSION_ID", "f95c9363-1fc8-4d7c-bdb2-7910930a47e7")
	if got := resolveMessageSender(""); got != "shuttle://sender/claude/f95c9363-1fc8-4d7c-bdb2-7910930a47e7" {
		t.Fatalf("sender = %q", got)
	}
	t.Setenv("CLAUDE_CODE_SESSION_ID", "")
	if got := resolveMessageSender(""); got != "external" {
		t.Fatalf("sender outside a harness = %q", got)
	}
}

// Pi's bash tool exports PI_SESSION_ID (the id its felt extension registers)
// and Pi marks its process AI_AGENT=pi. A Pi sender must get a pi reply
// address, including when Pi runs nested under a Claude or Codex session whose
// ids it inherits.
func TestResolveMessageSenderFromPiSession(t *testing.T) {
	t.Setenv("SHUTTLE_HOST", "sender")
	const pi = "019a8f2e-7c1d-7b3e-9f40-5d6c7b8a9e01"
	for _, tc := range []struct{ name, aiAgent, codex, claude, piID, want string }{
		{"pi alone", "pi", "", "", pi, "shuttle://sender/pi/" + pi},
		{"pi without marker", "", "", "", pi, "shuttle://sender/pi/" + pi},
		{"pi nested in claude", "pi", "", "claude-parent", pi, "shuttle://sender/pi/" + pi},
		{"pi nested in codex", "pi", "codex-parent", "", pi, "shuttle://sender/pi/" + pi},
		{"codex nested in pi (pinned trade-off: indistinguishable from pi nested in codex)", "pi", "codex-child", "", pi, "shuttle://sender/pi/" + pi},
		{"claude nested in pi", "claude-code_2-1-285_agent", "", "claude-child", pi, "shuttle://sender/claude/claude-child"},
		{"pi marker without id", "pi", "", "claude-parent", "", "shuttle://sender/claude/claude-parent"},
		{"outside a harness", "pi", "", "", "", "external"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("AI_AGENT", tc.aiAgent)
			t.Setenv("CODEX_THREAD_ID", tc.codex)
			t.Setenv("CLAUDE_SESSION_ID", "")
			t.Setenv("CLAUDE_CODE_SESSION_ID", tc.claude)
			t.Setenv("PI_SESSION_ID", tc.piID)
			if got := resolveMessageSender(""); got != tc.want {
				t.Fatalf("sender = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestFilterPeerDirectoryAppliesHostAndHarness(t *testing.T) {
	directory := messaging.Directory{
		Host: "hub",
		Sessions: []messaging.Session{
			{Address: "shuttle://b/codex/2", Host: "b", Harness: "codex"},
			{Address: "shuttle://a/codex/1", Host: "a", Harness: "codex"},
			{Address: "shuttle://a/claude/3", Host: "a", Harness: "claude", Fiber: "work/worker"},
		},
		Gaps: []messaging.Gap{
			{Host: "a", Harness: "codex", Error: "down"},
			{Host: "b", Harness: "codex", Error: "down"},
			{Host: "a", Harness: "claude-code", Error: "down"},
		},
	}
	got := filterPeerDirectory(directory, "a", "codex")
	if len(got.Sessions) != 1 || got.Sessions[0].Address != "shuttle://a/codex/1" {
		t.Fatalf("unexpected sessions: %#v", got.Sessions)
	}
	if len(got.Gaps) != 1 || got.Gaps[0].Host != "a" {
		t.Fatalf("unexpected gaps: %#v", got.Gaps)
	}
	got = filterPeerDirectory(directory, "a", "claude-code")
	if len(got.Sessions) != 1 || got.Sessions[0].Address != "shuttle://a/claude/3" || got.Sessions[0].Fiber != "work/worker" {
		t.Fatalf("alias filter lost the fiber discovery row: %#v", got.Sessions)
	}
	if len(got.Gaps) != 1 || got.Gaps[0].Harness != "claude-code" {
		t.Fatalf("alias filter lost its discovery gap: %#v", got.Gaps)
	}
}
