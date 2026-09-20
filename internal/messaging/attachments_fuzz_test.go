package messaging

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func FuzzAttachmentWireRoundTrip(f *testing.F) {
	f.Add("notes.bin", []byte{0, 255, '\n'}, "hello")
	f.Add("../escape", []byte("payload"), "")
	f.Add("résumé.txt", []byte{}, "file only")
	f.Add("bad\u0085name", []byte("x"), "")
	f.Fuzz(func(t *testing.T, name string, data []byte, text string) {
		if len(name) > 1024 || len(data) > 8192 || len(text) > 8192 {
			t.Skip()
		}
		request := Request{Address: "shuttle://host/codex/thread", MessageID: "fuzz", Text: text, Attachments: []Attachment{testAttachment(name, data)}}
		if validateRequest("host", request) != nil {
			return
		}
		if filepath.Base(name) != name || strings.ContainsAny(name, `/\`) {
			t.Fatalf("accepted a path as a filename: %q", name)
		}
		wire, err := json.Marshal(request)
		if err != nil {
			t.Fatal(err)
		}
		var decoded Request
		if err := json.Unmarshal(wire, &decoded); err != nil {
			t.Fatal(err)
		}
		if err := validateRequest("host", decoded); err != nil {
			t.Fatalf("valid request became invalid over JSON: %v", err)
		}
		if string(decoded.Attachments[0].Data) != string(data) || requestHash(decoded) != requestHash(request) {
			t.Fatal("wire round trip changed file bytes or retry identity")
		}
		decoded.Attachments[0] = testAttachment(name, append(append([]byte{}, data...), 0))
		if requestHash(decoded) == requestHash(request) {
			t.Fatal("changed file bytes retained retry identity")
		}
	})
}
