package shuttle

import (
	"strings"
	"testing"
)

func TestThreadAgentHandsALeadsThreadsToTheWorker(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	writeUserRegistry(t, env, `{"version":1,"agents":[
	  {"id":"fable-high","alias_of":"claude-fable","axes":{"effort":"high"}},
	  {"id":"fable-to-codex","alias_of":"claude-fable","thread_agent":"codex-sol"},
	  {"id":"my-lead","cli":"claude","model":"x","lead_only":true,"thread_agent":"agy-neon"},
	  {"id":"my-worker","cli":"claude","model":"y"}
	]}`)
	reg, err := LoadAgentRegistry(env)
	if err != nil {
		t.Fatal(err)
	}
	for parent, want := range map[string]string{
		"claude-fable":   "claude-opus",
		"pi-fable":       "claude-opus",
		"fable-high":     "claude-opus",
		"fable-to-codex": "codex-sol",
		"my-lead":        "agy-neon",
		"claude-opus":    "claude-opus",
		"agy-neon":       "agy-neon",
		"my-worker":      "my-worker",
		"":               "",
		"no-such-agent":  "no-such-agent",
	} {
		if got := reg.ThreadAgent(parent); got != want {
			t.Errorf("ThreadAgent(%q) = %q, want %q", parent, got, want)
		}
	}
	if len(reg.Warnings()) != 0 {
		t.Fatalf("unexpected warnings: %v", reg.Warnings())
	}
}

func TestUserFileCanReleaseOrRedirectABuiltinLead(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	writeUserRegistry(t, env, `{"version":1,"agents":[
	  {"id":"claude-fable","cli":"claude","model":"fable","effort_levels":["low","high"]},
	  {"id":"pi-fable","cli":"pi","model":"claude-fable-5-2","lead_only":true,"thread_agent":"pi-opus"}
	]}`)
	reg, err := LoadAgentRegistry(env)
	if err != nil {
		t.Fatal(err)
	}
	if got := reg.ThreadAgent("claude-fable"); got != "claude-fable" {
		t.Fatalf("a user record without lead_only replaces the builtin wholesale; got %q", got)
	}
	if got := reg.ThreadAgent("pi-fable"); got != "pi-opus" {
		t.Fatalf("ThreadAgent(pi-fable) = %q, want pi-opus", got)
	}
}

func TestUnknownThreadAgentWarns(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	writeUserRegistry(t, env, `{"version":1,"agents":[
	  {"id":"my-lead","cli":"claude","model":"x","lead_only":true,"thread_agent":"nobody"}
	]}`)
	reg, err := LoadAgentRegistry(env)
	if err != nil {
		t.Fatal(err)
	}
	if w := strings.Join(reg.Warnings(), "\n"); !strings.Contains(w, `"my-lead" names unknown thread_agent "nobody"`) {
		t.Fatalf("warnings = %q", w)
	}
}

func TestBuiltinFablesAreLeadOnly(t *testing.T) {
	t.Parallel()
	reg, err := LoadBuiltinAgentRegistry()
	if err != nil {
		t.Fatal(err)
	}
	for _, rec := range reg.Records() {
		want := rec.ID == "claude-fable" || rec.ID == "pi-fable"
		if rec.LeadOnly != want {
			t.Errorf("%s lead_only = %v, want %v", rec.ID, rec.LeadOnly, want)
		}
	}
}
