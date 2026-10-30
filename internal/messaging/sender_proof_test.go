package messaging

import "testing"

func TestSenderProofBindsMessageAndCanBeConsumedOnce(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	request := Request{Address: "shuttle://host/codex/receiver", Text: "hello", From: "shuttle://host/codex/sender", FromClaim: "bob", ReplyTo: "work/fiber", MessageID: "proof-test"}
	token, err := CreateSenderProof(env, request)
	if err != nil {
		t.Fatal(err)
	}
	request.SenderProof = token
	if sender, ok, err := VerifySenderProof(env, request, false); err != nil || !ok || sender != request.From {
		t.Fatalf("verify = %q, %v, %v", sender, ok, err)
	}
	changed := request
	changed.Text = "spoofed"
	if _, ok, err := VerifySenderProof(env, changed, false); err != nil || ok {
		t.Fatalf("changed payload accepted: %v, %v", ok, err)
	}
	if sender, ok, err := VerifySenderProof(env, request, true); err != nil || !ok || sender != request.From {
		t.Fatalf("consume = %q, %v, %v", sender, ok, err)
	}
	if _, ok, err := VerifySenderProof(env, request, true); err != nil || ok {
		t.Fatalf("replayed proof accepted: %v, %v", ok, err)
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
