package messaging

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"
)

func testAttachment(name string, data []byte) Attachment {
	digest := sha256.Sum256(data)
	return Attachment{Name: name, Data: data, SHA256: hex.EncodeToString(digest[:])}
}

func TestPartialAttachmentWriteRemainsDefiniteRejection(t *testing.T) {
	root := t.TempDir()
	t.Setenv("SHUTTLE_DATA_DIR", root)
	request := Request{Address: "shuttle://host/codex/thread", MessageID: "partial-files", Attachments: []Attachment{testAttachment("first.bin", []byte("first")), testAttachment("second.bin", []byte("second"))}}
	idHash := sha256.Sum256([]byte(request.MessageID))
	dir := filepath.Join(root, "message-files", hex.EncodeToString(idHash[:]))
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "02"), []byte("blocks directory creation"), 0600); err != nil {
		t.Fatal(err)
	}
	receipt, err := Send(context.Background(), "host", request)
	if ErrorCode(err) != "preflight_failed" || receipt.Status != StatusRejected || len(receipt.Files) != 0 {
		t.Fatalf("partial write was not a definite rejection: %+v %v", receipt, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "01", "first.bin")); err != nil {
		t.Fatal("test did not reach partial storage", err)
	}
}

func TestReadAttachmentsPreservesBinaryBytes(t *testing.T) {
	dir := t.TempDir()
	want := []byte{0, 1, 2, 0xff, '\n', 0}
	path := filepath.Join(dir, "payload.bin")
	if err := os.WriteFile(path, want, 0600); err != nil {
		t.Fatal(err)
	}
	got, err := ReadAttachments([]string{path})
	if err != nil || len(got) != 1 || got[0].Name != "payload.bin" || !reflect.DeepEqual(got[0].Data, want) {
		t.Fatalf("ReadAttachments() = %#v, %v", got, err)
	}
	if err := validateAttachments(got); err != nil {
		t.Fatal(err)
	}
}

func TestReadAttachmentsRejectsFIFOWithoutBlocking(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pipe")
	if err := syscall.Mkfifo(path, 0600); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := ReadAttachments([]string{path})
		done <- err
	}()
	select {
	case err := <-done:
		if ErrorCode(err) != "invalid_request" {
			t.Fatalf("ReadAttachments() error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("ReadAttachments blocked opening a FIFO")
	}
}

func TestAttachmentValidationRejectsMalformedInput(t *testing.T) {
	base := Request{Address: "shuttle://host/codex/session", Text: "message", MessageID: "id"}
	tests := []struct {
		name        string
		attachments []Attachment
	}{
		{"traversal", []Attachment{testAttachment("../secret", []byte("x"))}},
		{"slash", []Attachment{testAttachment("a/b", []byte("x"))}},
		{"backslash", []Attachment{testAttachment(`a\b`, []byte("x"))}},
		{"control", []Attachment{testAttachment("bad\nname", []byte("x"))}},
		{"digest", []Attachment{{Name: "x", Data: []byte("x"), SHA256: strings.Repeat("0", 64)}}},
		{"uppercase digest", []Attachment{{Name: "x", Data: nil, SHA256: strings.ToUpper(testAttachment("x", nil).SHA256)}}},
		{"too large", []Attachment{testAttachment("x", make([]byte, MaxAttachmentBytes+1))}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := base
			req.Attachments = tc.attachments
			if err := validateRequest("host", req); ErrorCode(err) != "invalid_request" {
				t.Fatalf("validateRequest() error = %v", err)
			}
		})
	}
	tooMany := make([]Attachment, MaxAttachments+1)
	for i := range tooMany {
		tooMany[i] = testAttachment("x", nil)
	}
	base.Attachments = tooMany
	if err := validateRequest("host", base); ErrorCode(err) != "invalid_request" {
		t.Fatalf("count error = %v", err)
	}
}

func TestRequestHashWithoutAttachmentsIsCompatible(t *testing.T) {
	req := Request{Address: "shuttle://h/codex/x", Text: "hello", From: "sender", Wake: true, MessageID: "ignored"}
	b, _ := json.Marshal(struct {
		Address, Text, From string
		Wake                bool
	}{req.Address, req.Text, req.From, req.Wake})
	want := sha256.Sum256(b)
	if got := requestHash(req); got != hex.EncodeToString(want[:]) {
		t.Fatalf("requestHash() = %s, want legacy %x", got, want)
	}
}

func TestSendMaterializesFilesAndQueuesReferencesOnce(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("SHUTTLE_DATA_DIR", dataDir)
	t.Setenv("SHUTTLE_CODEX_SOCKET", filepath.Join(dataDir, "missing.sock"))
	if err := RegisterMailbox("codex", "session", "host", "/work", true); err != nil {
		t.Fatal(err)
	}
	attachments := []Attachment{
		testAttachment("same.bin", []byte{0, 1, 0xff}),
		testAttachment("same.bin", []byte("second")),
	}
	req := Request{Address: "shuttle://host/codex/session", MessageID: "with-files", Attachments: attachments}
	first, err := Send(context.Background(), "host", req)
	if err != nil || first.Status != StatusQueued || len(first.Files) != 2 {
		t.Fatalf("first Send() = %#v, %v", first, err)
	}
	if filepath.Base(filepath.Dir(first.Files[0].Path)) != "01" || filepath.Base(filepath.Dir(first.Files[1].Path)) != "02" || filepath.Base(first.Files[0].Path) != "same.bin" || filepath.Base(first.Files[1].Path) != "same.bin" {
		t.Fatalf("receiver names = %#v", first.Files)
	}
	root := filepath.Join(dataDir, "message-files") + string(os.PathSeparator)
	for i, file := range first.Files {
		if !filepath.IsAbs(file.Path) || !strings.HasPrefix(file.Path, root) {
			t.Fatalf("path escaped receiver store: %q", file.Path)
		}
		got, readErr := os.ReadFile(file.Path)
		if readErr != nil || !reflect.DeepEqual(got, attachments[i].Data) {
			t.Fatalf("file %d = %v, %v", i, got, readErr)
		}
	}
	second, err := Send(context.Background(), "host", req)
	if err != nil || !reflect.DeepEqual(second, first) {
		t.Fatalf("replay Send() = %#v, %v; want %#v", second, err, first)
	}
	var offered []Request
	if err := OfferMailbox("codex", "session", "host", func(batch []Request) error {
		offered = append(offered, batch...)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(offered) != 1 || len(offered[0].Attachments) != 0 || !strings.Contains(offered[0].Text, first.Files[0].Path) || !strings.Contains(offered[0].Text, first.Files[0].SHA256) {
		t.Fatalf("mailbox payload = %#v", offered)
	}
	if strings.Contains(offered[0].Text, "AAH/") {
		t.Fatalf("mailbox contains base64 payload: %q", offered[0].Text)
	}
}

func TestMaterializePreservesMaximumLengthName(t *testing.T) {
	t.Setenv("SHUTTLE_DATA_DIR", t.TempDir())
	name := strings.Repeat("a", 255)
	files, err := materializeAttachments("long-name", []Attachment{testAttachment(name, []byte("data"))})
	if err != nil || len(files) != 1 {
		t.Fatalf("materializeAttachments() = %#v, %v", files, err)
	}
	if filepath.Base(files[0].Path) != name {
		t.Fatalf("receiver basename length = %d, want 255", len(filepath.Base(files[0].Path)))
	}
	if got, err := os.ReadFile(files[0].Path); err != nil || string(got) != "data" {
		t.Fatalf("receiver file = %q, %v", got, err)
	}
}

func TestAttachmentPayloadChangeConflictsOnMessageID(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("SHUTTLE_DATA_DIR", dataDir)
	t.Setenv("SHUTTLE_CODEX_SOCKET", filepath.Join(dataDir, "missing.sock"))
	if err := RegisterMailbox("codex", "session", "host", "/work", true); err != nil {
		t.Fatal(err)
	}
	req := Request{Address: "shuttle://host/codex/session", MessageID: "same-id", Attachments: []Attachment{testAttachment("x", []byte("one"))}}
	if _, err := Send(context.Background(), "host", req); err != nil {
		t.Fatal(err)
	}
	req.Attachments = []Attachment{testAttachment("x", []byte("two"))}
	if receipt, err := Send(context.Background(), "host", req); ErrorCode(err) != "message_id_conflict" || receipt.Status != StatusRejected {
		t.Fatalf("Send() = %#v, %v", receipt, err)
	}
}

func TestPreexistingSymlinkPreventsDelivery(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("SHUTTLE_DATA_DIR", dataDir)
	t.Setenv("SHUTTLE_CODEX_SOCKET", filepath.Join(dataDir, "missing.sock"))
	if err := RegisterMailbox("codex", "session", "host", "/work", true); err != nil {
		t.Fatal(err)
	}
	messageID := "symlink"
	idHash := sha256.Sum256([]byte(messageID))
	dir := filepath.Join(dataDir, "message-files", hex.EncodeToString(idHash[:]))
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "01"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(dataDir, "elsewhere"), filepath.Join(dir, "01", "x")); err != nil {
		t.Fatal(err)
	}
	req := Request{Address: "shuttle://host/codex/session", MessageID: messageID, Attachments: []Attachment{testAttachment("x", []byte("data"))}}
	if receipt, err := Send(context.Background(), "host", req); ErrorCode(err) != "preflight_failed" || receipt.Status != StatusRejected {
		t.Fatalf("Send() = %#v, %v", receipt, err)
	}
	pending, err := os.ReadDir(filepath.Join(mailboxDir("codex", "session"), "pending"))
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if len(pending) != 0 {
		t.Fatalf("adapter queued %d messages", len(pending))
	}
}
