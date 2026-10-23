package shuttlecli

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

// A model name is the commonest wrong agent id: claude-opus-5-5 names Claude's
// model, which several registry agents run, and no agent itself.
const notAnAgent = "claude-opus-5-5"
const notAnAgentWords = "claude-opus-5-5 is not an agent; `shuttle agents` lists them"

func TestEveryAgentWriteRejectsAnIdTheRegistryDoesNotKnow(t *testing.T) {
	t.Parallel()
	pdir := t.TempDir()
	for name, args := range map[string][]string{
		"set-agent":    {"set-agent", "f", notAnAgent},
		"set-model":    {"set-model", "f", notAnAgent},
		"install -m":   {"install", "plain", "--host", "testhost", "--project-dir", pdir, "-m", notAnAgent},
		"thread agent": {"thread", "f", "Look into it", "--agent", notAnAgent},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			dir, storage := newStore(t)
			seedShuttleRole(t, storage, "f", felt.StatusActive, oneshot(), nil)
			seedPlainFiber(t, storage, "plain", "")
			_, stderr, err := executeIn(t, env, dir, args...)
			if err == nil {
				t.Fatalf("%s accepted %s", name, notAnAgent)
			}
			if got := stderr + err.Error(); !strings.Contains(got, notAnAgentWords) {
				t.Fatalf("%s refusal does not name the id and the way to the list:\n%s", name, got)
			}
			if block := mustRead(t, storage, "f").ExtraFields["shuttle"]; strings.Contains(stringify(block), notAnAgent) {
				t.Fatalf("%s wrote the id anyway: %v", name, block)
			}
		})
	}
}

func TestHandoffRefusesABlockNamingAnUnknownAgent(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("SHUTTLE_FIBER_PATH", "")
	dir, storage := newStore(t)
	block := oneshot()
	block["agent"] = notAnAgent
	seedShuttleRole(t, storage, "f", felt.StatusActive, block, nil)

	_, _, err := executeIn(t, env, dir, "handoff", "f")
	if err == nil || !strings.Contains(err.Error(), notAnAgentWords) || !strings.Contains(err.Error(), "shuttle set-agent") {
		t.Fatalf("handoff must refuse and name the fix, got %v", err)
	}
	if strings.Contains(stringify(mustRead(t, storage, "f").ExtraFields["shuttle"]), "handed_off_at") {
		t.Fatal("a refused handoff stamped handed_off_at")
	}

	block["agent"] = "claude-opus"
	seedShuttleRole(t, storage, "g", felt.StatusActive, block, nil)
	if _, _, err := executeIn(t, env, dir, "handoff", "g"); err != nil {
		t.Fatalf("handoff of a known agent: %v", err)
	}
}

func TestStatusFlagsABlockNamingAnUnknownAgent(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	block := oneshot()
	block["agent"] = notAnAgent
	seedShuttleRole(t, storage, "f", felt.StatusActive, block, nil)
	seedShuttleRole(t, storage, "g", felt.StatusActive, oneshot(), nil)
	env.Set("SHUTTLE_STORES", dir)

	one, err := runIn(t, env, dir, "status", "f")
	if err != nil || !strings.Contains(one, notAnAgentWords) {
		t.Fatalf("status f does not flag the agent (%v):\n%s", err, one)
	}
	table, err := runIn(t, env, dir, "status")
	if err != nil || !strings.Contains(table, notAnAgentWords) {
		t.Fatalf("the status table does not flag the agent (%v):\n%s", err, table)
	}
	out, err := runIn(t, env, dir, "--json", "status")
	if err != nil {
		t.Fatal(err)
	}
	var rows []FiberStatus
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	for _, row := range rows {
		if want := row.FiberID == "f"; (row.AgentProblem != "") != want {
			t.Fatalf("row %s agent_problem = %q", row.FiberID, row.AgentProblem)
		}
	}
}

func stringify(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
