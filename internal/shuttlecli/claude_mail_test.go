package shuttlecli

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/cailmdaley/felt/internal/messaging"
)

func TestClaudeRecoveryNoticesComeFromShuttle(t *testing.T) {
	env := messageHookEnv(t, "host")
	dir := filepath.Join(env.Getenv("SHUTTLE_DATA_DIR"), "mailboxes", "claude", "session", "fallback")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{
		"request":  messaging.Request{Address: "shuttle://host/claude/session", MessageID: "failed", From: "shuttle://host/pi/sender", Text: "task", ContextIfBusy: true},
		"fallback": map[string]any{"receipt": messaging.Receipt{Status: messaging.StatusRejected}, "error_code": "refused", "error_message": "receiver refused"},
	})
	if err := os.WriteFile(filepath.Join(dir, "failed.json"), body, 0600); err != nil {
		t.Fatal(err)
	}
	seen := false
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req messaging.Request
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
			return
		}
		if req.From != "shuttle" {
			t.Errorf("notice sender = %q", req.From)
		}
		seen = true
		_ = json.NewEncoder(w).Encode(messaging.Receipt{Address: req.Address, MessageID: req.MessageID, Status: messaging.StatusAccepted, Transport: "pi-native"})
	}))
	cmd := newApp(env).claudeMailRecoverCmd()
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if !seen {
		t.Fatal("no failure notice")
	}
}
