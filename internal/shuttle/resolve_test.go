package shuttle

import (
	"testing"
	"time"
)

// TestNewResolvedAgent_MatchesResolveBlock locks the contract the
// `felt shuttle agents resolve` verb relies on: resolving a name+axes directly
// (reg.Resolve → NewResolvedAgent — the verb's path, used by the daemon's
// capture flow) yields the byte-identical record ResolveBlock emits under
// shuttle.resolved.agent (the poll/dispatch path). One projection, two callers.
func TestNewResolvedAgent_MatchesResolveBlock(t *testing.T) {
	reg, err := LoadAgentRegistry()
	if err != nil {
		t.Fatalf("LoadAgentRegistry: %v", err)
	}
	for _, name := range []string{"claude-opus", "claude-opus-chrome", "codex", "pi-sonnet"} {
		block := &Block{Kind: "oneshot", Agent: name, Effort: "", Chrome: false}
		viaBlock, err := ResolveBlock(block, reg, time.Now())
		if err != nil {
			t.Fatalf("ResolveBlock(%s): %v", name, err)
		}
		rec, axes, err := reg.Resolve(name, "", false)
		if err != nil {
			t.Fatalf("Resolve(%s): %v", name, err)
		}
		viaVerb := NewResolvedAgent(rec, axes)
		if *viaVerb != *viaBlock.Agent {
			t.Fatalf("%s: verb path %+v != block path %+v", name, viaVerb, viaBlock.Agent)
		}
	}
}

func TestResolveBlock_Oneshot(t *testing.T) {
	reg, err := LoadAgentRegistry()
	if err != nil {
		t.Fatalf("LoadAgentRegistry: %v", err)
	}
	res, err := ResolveBlock(&Block{Kind: "oneshot", Agent: "claude-opus"}, reg, time.Now())
	if err != nil {
		t.Fatalf("ResolveBlock: %v", err)
	}
	if res.Agent == nil {
		t.Fatal("expected an agent to resolve")
	}
	if res.Agent.CLI != "claude" || res.Agent.Model != "opus" {
		t.Fatalf("resolved agent = %+v, want claude/opus", res.Agent)
	}
	if res.Agent.Effort != "xhigh" {
		t.Fatalf("effort = %q, want xhigh (claude-opus default)", res.Agent.Effort)
	}
	if res.NextDue != nil {
		t.Fatalf("oneshot should have no next_due, got %v", res.NextDue)
	}
}

func TestResolveBlock_StandingNextDue(t *testing.T) {
	reg, err := LoadAgentRegistry()
	if err != nil {
		t.Fatalf("LoadAgentRegistry: %v", err)
	}
	b := &Block{Kind: "standing", Agent: "claude-sonnet", Schedule: &Schedule{Expr: "0 9 * * 1-5", TZ: "Europe/Paris"}}
	now := time.Date(2026, 6, 21, 12, 0, 0, 0, time.UTC)
	res, err := ResolveBlock(b, reg, now)
	if err != nil {
		t.Fatalf("ResolveBlock: %v", err)
	}
	if res.NextDue == nil {
		t.Fatal("standing role should have a next_due")
	}
	nd := *res.NextDue
	if !nd.After(now) {
		t.Fatalf("next_due %v should be after now %v", nd, now)
	}
	if nd.Hour() != 9 {
		t.Fatalf("next_due hour = %d, want 9 (Paris wall time)", nd.Hour())
	}
	if nd.Weekday() == time.Saturday || nd.Weekday() == time.Sunday {
		t.Fatalf("next_due %v lands on a weekend; cron is Mon-Fri", nd)
	}
}

// TestResolveBlock_StandingPrevDue locks the field the daemon's catch-up
// dispatch decision reads: a standing role resolves a prev_due (most recent tick
// ≤ now) that brackets now with next_due. A oneshot has neither.
func TestResolveBlock_StandingPrevDue(t *testing.T) {
	reg, err := LoadAgentRegistry()
	if err != nil {
		t.Fatalf("LoadAgentRegistry: %v", err)
	}
	b := &Block{Kind: "standing", Agent: "claude-sonnet", Schedule: &Schedule{Expr: "0 9 * * 1-5", TZ: "Europe/Paris"}}
	now := time.Date(2026, 6, 21, 12, 0, 0, 0, time.UTC)
	res, err := ResolveBlock(b, reg, now)
	if err != nil {
		t.Fatalf("ResolveBlock: %v", err)
	}
	if res.PrevDue == nil {
		t.Fatal("standing role should have a prev_due")
	}
	if res.NextDue == nil {
		t.Fatal("standing role should have a next_due")
	}
	if res.PrevDue.After(now) {
		t.Fatalf("prev_due %v must be <= now %v", *res.PrevDue, now)
	}
	if !res.NextDue.After(now) {
		t.Fatalf("next_due %v must be > now %v", *res.NextDue, now)
	}

	// Oneshot: neither boundary resolves.
	one, err := ResolveBlock(&Block{Kind: "oneshot", Agent: "claude-opus"}, reg, now)
	if err != nil {
		t.Fatalf("ResolveBlock oneshot: %v", err)
	}
	if one.PrevDue != nil {
		t.Fatalf("oneshot should have no prev_due, got %v", one.PrevDue)
	}
}

// TestResolveBlock_ImpossibleSchedule: a grammatical but unsatisfiable schedule
// (Feb 30) resolves no occurrence — robfig's Next returns the zero time, which
// ResolveBlock must drop rather than emit as a year-0001 next_due. The daemon
// then sees an unschedulable (invalid) standing role, matching the old behavior.
func TestResolveBlock_ImpossibleSchedule(t *testing.T) {
	reg, err := LoadAgentRegistry()
	if err != nil {
		t.Fatalf("LoadAgentRegistry: %v", err)
	}
	b := &Block{Kind: "standing", Agent: "claude-sonnet", Schedule: &Schedule{Expr: "0 0 30 2 *", TZ: "UTC"}}
	res, err := ResolveBlock(b, reg, time.Now())
	if err != nil {
		t.Fatalf("ResolveBlock: %v", err)
	}
	if res.NextDue != nil {
		t.Fatalf("impossible schedule should emit no next_due, got %v", *res.NextDue)
	}
	if res.PrevDue != nil {
		t.Fatalf("impossible schedule should emit no prev_due, got %v", *res.PrevDue)
	}
	// The agent still resolves — only the occurrence is dropped.
	if res.Agent == nil {
		t.Fatal("agent should still resolve for an impossible schedule")
	}
}

func TestResolveBlock_UnknownAgentErrors(t *testing.T) {
	reg, err := LoadAgentRegistry()
	if err != nil {
		t.Fatalf("LoadAgentRegistry: %v", err)
	}
	if _, err := ResolveBlock(&Block{Kind: "oneshot", Agent: "no-such-agent"}, reg, time.Now()); err == nil {
		t.Fatal("an unknown agent should make ResolveBlock error")
	}
}

func TestResolveBlock_DefaultsUnnamedAgent(t *testing.T) {
	reg, err := LoadAgentRegistry()
	if err != nil {
		t.Fatalf("LoadAgentRegistry: %v", err)
	}
	res, err := ResolveBlock(&Block{Kind: "oneshot"}, reg, time.Now())
	if err != nil {
		t.Fatalf("ResolveBlock: %v", err)
	}
	if res.Agent == nil || res.Agent.ID != "claude-sonnet" {
		t.Fatalf("unnamed agent should resolve to the registry default (claude-sonnet), got %+v", res.Agent)
	}
}
