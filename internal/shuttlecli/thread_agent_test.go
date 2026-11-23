package shuttlecli

import (
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

func TestThreadAgentDefaultsAwayFromALead(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, parent, want string
		args               []string
	}{
		{"claude-fable lead", "claude-fable", "claude-opus", nil},
		{"pi-fable lead", "pi-fable", "claude-opus", nil},
		{"alias of a lead", "fable-high", "claude-opus", nil},
		{"user lead with thread_agent", "my-lead", "codex-sol", nil},
		{"explicit fable thread", "claude-fable", "claude-fable", []string{"--agent", "claude-fable"}},
		{"opus inherits", "claude-opus", "claude-opus", nil},
		{"neon inherits", "agy-neon", "agy-neon", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			userRegistry(t, env, `{"version":1,"agents":[
			  {"id":"fable-high","alias_of":"claude-fable","axes":{"effort":"high"}},
			  {"id":"my-lead","cli":"claude","model":"x","lead_only":true,"thread_agent":"codex-sol"}
			]}`)
			dir, storage := newStore(t)
			block := oneshot()
			block["agent"] = tc.parent
			seedShuttleRole(t, storage, "lead", felt.StatusActive, block, nil)

			args := append([]string{"thread", "lead", "Look into it", "--disabled"}, tc.args...)
			stdout, _, err := executeIn(t, env, dir, args...)
			if err != nil {
				t.Fatalf("thread: %v", err)
			}
			child, ok, err := shuttle.BlockOf(mustRead(t, storage, strings.TrimSpace(stdout)))
			if err != nil || !ok {
				t.Fatalf("child block: %v %v", ok, err)
			}
			if child.Agent != tc.want {
				t.Fatalf("thread agent = %q, want %q", child.Agent, tc.want)
			}
		})
	}
}
