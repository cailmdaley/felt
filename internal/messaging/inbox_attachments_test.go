package messaging

import (
	"os"
	"strings"
	"testing"
)

func TestFiberInboxAttachmentsAreRetainedReferences(t *testing.T) {
	env := testEnv(t)
	attachment := testAttachment("image.png", []byte(strings.Repeat("binary-data", 100000)))
	entry := InboxEntry{Address: "fiber", Request: Request{MessageID: "attached", Text: "Inspect this", Attachments: []Attachment{attachment}}, Wishes: Wishes{Turn: "ask"}}
	for i := 0; i < 2; i++ {
		if err := Enqueue(env, entry); err != nil {
			t.Fatal(err)
		}
	}
	root := mailboxDir(env, "fiber", "fiber")
	e, err := readFiberMailboxEntry(root + "/pending/" + mailboxKey("attached") + ".json")
	if err != nil || len(e.Request.Attachments) != 0 || !strings.Contains(e.Request.Text, "image.png") {
		t.Fatalf("%+v %v", e, err)
	}
	files, err := materializeAttachments(env, "attached", []Attachment{attachment})
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(files[0].Path)
	if err != nil || string(b) != string(attachment.Data) {
		t.Fatalf("retained attachment: %v", err)
	}
}
