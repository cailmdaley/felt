package shuttlecli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/cailmdaley/felt/internal/shuttle"
)

func TestContextMailboxFromFlagIsOnlyAClaim(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "host")
	env.Set("CODEX_THREAD_ID", "real-thread")
	cmd := NewRootCmd(env)
	cmd.SetArgs([]string{"context-mailbox", "put", "fiber", "message-1", "hello", "--from", "bob"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}

	var request messaging.Request
	data, err := shuttle.DataDir(env)
	if err != nil {
		t.Fatal(err)
	}
	err = filepath.WalkDir(data, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() || filepath.Ext(path) != ".json" {
			return err
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var record struct {
			Request messaging.Request `json:"request"`
		}
		if json.Unmarshal(b, &record) == nil && record.Request.MessageID == "message-1" {
			request = record.Request
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if request.MessageID != "message-1" {
		t.Fatal("queued context message was not recorded")
	}
	if request.From != "shuttle" || request.FromClaim != "bob" {
		t.Fatalf("sender attribution = %q, claim = %q", request.From, request.FromClaim)
	}
}

func TestContextMailboxConsumesLocalSenderProof(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "host")
	env.Set("CODEX_THREAD_ID", "real-thread")
	proofRequest := messaging.Request{
		From:      "shuttle://host/codex/real-thread",
		Address:   "fiber-target",
		Text:      "hello",
		MessageID: "message-proof",
		FromClaim: "operator-label",
	}
	proof, err := messaging.CreateSenderProof(env, proofRequest)
	if err != nil {
		t.Fatal(err)
	}
	cmd := NewRootCmd(env)
	cmd.SetArgs([]string{
		"context-mailbox", "put", "fiber", proofRequest.MessageID, proofRequest.Text,
		"--from", proofRequest.From, "--from-claim", proofRequest.FromClaim,
		"--sender-proof", proof, "--proof-address", proofRequest.Address,
	})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	var stored messaging.Request
	data, err := shuttle.DataDir(env)
	if err != nil {
		t.Fatal(err)
	}
	err = filepath.WalkDir(data, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() || filepath.Ext(path) != ".json" {
			return err
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var record struct {
			Request messaging.Request `json:"request"`
		}
		if json.Unmarshal(b, &record) == nil && record.Request.MessageID == proofRequest.MessageID {
			stored = record.Request
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if stored.From != proofRequest.From || stored.FromClaim != proofRequest.FromClaim {
		t.Fatalf("sender attribution = %q, claim = %q", stored.From, stored.FromClaim)
	}
	if stored.SenderProof != "" {
		t.Fatal("consumed proof was retained in context mailbox")
	}
	if _, valid, err := messaging.VerifySenderProof(env, proofRequestWithProof(proofRequest, proof), false); err != nil || valid {
		t.Fatalf("proof replay valid = %v, err = %v", valid, err)
	}
}

func proofRequestWithProof(request messaging.Request, proof string) messaging.Request {
	request.SenderProof = proof
	return request
}
