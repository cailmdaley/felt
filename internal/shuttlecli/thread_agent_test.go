package shuttlecli

import (
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

// A Fable parent with its own effort hands a thread to Opus without it: the
// child's effort comes from its own agent's default, not the lead's.
func TestRedirectedThreadDropsTheLeadsEffort(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	block := oneshot()
	block["agent"] = "claude-fable"
	block["effort"] = "high"
	seedShuttleRole(t, storage, "lead", felt.StatusActive, block, nil)
	stdout, _, err := executeIn(t, env, dir, "thread", "lead", "Look into it", "--disabled")
	if err != nil {
		t.Fatalf("thread: %v", err)
	}
	child, _, err := shuttle.BlockOf(mustRead(t, storage, strings.TrimSpace(stdout)))
	if err != nil {
		t.Fatal(err)
	}
	if child.Agent != "claude-opus" || child.Effort != "" {
		t.Fatalf("child agent=%q effort=%q; want claude-opus with no effort", child.Agent, child.Effort)
	}
}

func TestThreadAgentDefaultsAwayFromALead(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, parent, want string
		args               []string
	}{
		{"claude-fable lead", "claude-fable", "claude-opus", nil},
		{"pi-fable lead", "pi-fable", "claude-opus", nil},
		{"alias of a lead", "fable-high", "claude-opus", nil},
		{"mixed-case lead", "CLAUDE-FABLE", "claude-opus", nil},
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

// An alias row carries its base's lead status and its own thread_agent.
func TestAgentsTableMarksLeadAliases(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	userRegistry(t, env, `{"version":1,"agents":[
	  {"id":"fable-high","alias_of":"claude-fable","axes":{"effort":"high"}},
	  {"id":"fable-to-codex","alias_of":"claude-fable","thread_agent":"codex-sol"}
	]}`)
	stdout, _, err := runAgents(t, env, "agents")
	if err != nil {
		t.Fatalf("agents: %v", err)
	}
	for id, want := range map[string]string{
		"fable-high":     "+[effort=high lead]",
		"fable-to-codex": "+[lead threads=codex-sol]",
	} {
		var row string
		for _, line := range strings.Split(stdout, "\n") {
			if strings.Contains(line, " "+id+" ") {
				row = line
			}
		}
		if !strings.Contains(row, want) {
			t.Errorf("%s row = %q, want %q", id, row, want)
		}
	}
}
