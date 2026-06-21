package shuttle

import (
	"testing"
	"time"
)

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
