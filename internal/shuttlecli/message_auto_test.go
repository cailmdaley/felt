package shuttlecli

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/messaging"
)

func TestMessageAutomaticBusyPolicy(t *testing.T) {
	for _, tc := range []struct {
		name, harness, flag string
		wake, auto          bool
	}{
		{"Claude default", "claude", "", true, true},
		{"Claude forced wake", "claude", "true", true, false},
		{"Claude context", "claude", "false", false, false},
		{"Pi unchanged", "pi", "", true, false},
		{"Codex unchanged", "codex", "", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := testEnv(t)
			serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var request messaging.Request
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					t.Error(err)
					return
				}
				if request.Wake != tc.wake || request.ContextIfBusy != tc.auto {
					t.Errorf("request: %+v", request)
				}
				_ = json.NewEncoder(w).Encode(messaging.Receipt{MessageID: request.MessageID, Address: request.Address, Status: messaging.StatusAccepted, Transport: "claude-native"})
			}))
			var opts messageOptions
			cmd := newApp(env).messageCmd(&opts)
			if tc.flag != "" {
				if err := cmd.Flags().Set("wake", tc.flag); err != nil {
					t.Fatal(err)
				}
			}
			cmd.SetIn(strings.NewReader(""))
			cmd.SetOut(io.Discard)
			cmd.SetErr(io.Discard)
			if err := cmd.RunE(cmd, []string{"shuttle://host/" + tc.harness + "/session", "hello"}); err != nil {
				t.Fatal(err)
			}
		})
	}
}
