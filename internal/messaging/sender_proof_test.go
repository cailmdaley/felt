package messaging

import "testing"

func TestSenderProofBindsMessageAndCanBeConsumedOnce(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	request := Request{
		Address: "shuttle://host/codex/receiver", Text: "hello",
		From: "shuttle://host/codex/sender", FromClaim: "bob",
		ReplyTo: "work/fiber", MessageID: "proof-test", Wake: true,
		NotifyAddress: "shuttle://host/codex/notifier", NotifyWhenIdle: true,
		NotifyWake: true, ThreadSignal: &ThreadSignal{UID: "01UID", Verb: "close", Stamp: "stamp", Owner: "host"},
		Attachments: []Attachment{{Name: "note.txt", Data: []byte("evidence"), SHA256: "f9e8f40a6964e1460d29b73264f78caaef8baf2c9a7be7d11b3f9974feec3094"}},
	}
	token, err := CreateSenderProof(env, request)
	if err != nil {
		t.Fatal(err)
	}
	request.SenderProof = token
	if sender, ok, err := VerifySenderProof(env, request, false); err != nil || !ok || sender != request.From {
		t.Fatalf("verify = %q, %v, %v", sender, ok, err)
	}
	mutations := map[string]func(*Request){
		"text":             func(r *Request) { r.Text = "spoofed" },
		"wake":             func(r *Request) { r.Wake = false },
		"notify address":   func(r *Request) { r.NotifyAddress = "shuttle://host/codex/other" },
		"notify idle":      func(r *Request) { r.NotifyWhenIdle = false },
		"notify wake":      func(r *Request) { r.NotifyWake = false },
		"thread signal":    func(r *Request) { r.ThreadSignal.Verb = "rest" },
		"attachment bytes": func(r *Request) { r.Attachments[0].Data = []byte("forged") },
		"attachment name":  func(r *Request) { r.Attachments[0].Name = "other.txt" },
	}
	for name, mutate := range mutations {
		changed := request
		changed.Attachments = append([]Attachment(nil), request.Attachments...)
		changed.Attachments[0].Data = append([]byte(nil), request.Attachments[0].Data...)
		signalCopy := *request.ThreadSignal
		changed.ThreadSignal = &signalCopy
		mutate(&changed)
		if _, ok, err := VerifySenderProof(env, changed, false); err != nil || ok {
			t.Errorf("changed %s accepted: %v, %v", name, ok, err)
		}
	}
	if sender, ok, err := VerifySenderProof(env, request, false); err != nil || !ok {
		t.Fatalf("mutation table changed original request: sender=%q ok=%v err=%v request=%#v", sender, ok, err, request)
	}
	if sender, ok, err := VerifySenderProof(env, request, true); err != nil || !ok || sender != request.From {
		t.Fatalf("consume = %q, %v, %v", sender, ok, err)
	}
	if _, ok, err := VerifySenderProof(env, request, true); err != nil || ok {
		t.Fatalf("replayed proof accepted: %v, %v", ok, err)
	}
}

func TestSenderProofCanonicalizesEmptyAttachments(t *testing.T) {
	env := testEnv(t)
	request := Request{Address: "shuttle://host/pi/target", Text: "hello", MessageID: "empty-attachments", From: "shuttle://host/pi/sender", Attachments: make([]Attachment, 0)}
	token, err := CreateSenderProof(env, request)
	if err != nil {
		t.Fatal(err)
	}
	request.SenderProof = token
	if _, ok, err := VerifySenderProof(env, request, false); err != nil || !ok {
		t.Fatalf("empty slice proof did not round-trip: ok=%v err=%v", ok, err)
	}
	request.Attachments = nil
	if _, ok, err := VerifySenderProof(env, request, false); err != nil || !ok {
		t.Fatalf("nil attachment proof did not round-trip: ok=%v err=%v", ok, err)
	}
}

func TestRequestIdentityIncludesClaimButNotOneUseProof(t *testing.T) {
	request := Request{Address: "shuttle://host/pi/receiver", Text: "hello", From: "shuttle", FromClaim: "alice", MessageID: "retry"}
	retry := request
	retry.SenderProof = "fresh-proof"
	if requestHash(request) != requestHash(retry) {
		t.Fatal("a fresh sender proof changed request identity")
	}
	changed := request
	changed.FromClaim = "bob"
	if requestHash(request) == requestHash(changed) {
		t.Fatal("a changed sender claim reused the original receipt")
	}
}
