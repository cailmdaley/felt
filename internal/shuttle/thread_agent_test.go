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
		"CLAUDE-FABLE":   "claude-opus",
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
		if got, err := reg.ThreadAgent(parent); err != nil || got != want {
			t.Errorf("ThreadAgent(%q) = %q, %v; want %q", parent, got, err, want)
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
	if got, _ := reg.ThreadAgent("claude-fable"); got != "claude-fable" {
		t.Fatalf("a user record without lead_only replaces the builtin wholesale; got %q", got)
	}
	if got, _ := reg.ThreadAgent("pi-fable"); got != "pi-opus" {
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

// A restricted registry whose default is a lead — named or by position —
// falls back to its first base agent that is not.
func TestLeadOnlyDefaultFallsBackToAWorker(t *testing.T) {
	t.Parallel()
	for name, fable := range map[string]string{
		"first by position": `{"id":"claude-fable","cli":"claude","model":"fable","lead_only":true}`,
		"explicit default":  `{"id":"claude-fable","cli":"claude","model":"fable","lead_only":true,"default":true}`,
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			writeUserRegistry(t, env, `{"version":1,"builtins":"restrict","agents":[
			  `+fable+`,
			  {"id":"fable-alias","alias_of":"claude-fable"},
			  {"id":"claude-opus","cli":"claude","model":"opus"}
			]}`)
			reg, err := LoadAgentRegistry(env)
			if err != nil {
				t.Fatal(err)
			}
			for _, parent := range []string{"claude-fable", ""} {
				if got, err := reg.ThreadAgent(parent); err != nil || got != "claude-opus" {
					t.Errorf("ThreadAgent(%q) = %q, %v; want claude-opus", parent, got, err)
				}
			}
		})
	}
}

// An unnamed parent runs the default; when that default is a lead with a
// thread_agent, its threads go there.
func TestUnnamedParentIsJudgedAsTheDefault(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	writeUserRegistry(t, env, `{"version":1,"agents":[
	  {"id":"my-lead","cli":"claude","model":"x","lead_only":true,"thread_agent":"agy-neon","default":true}
	]}`)
	reg, err := LoadAgentRegistry(env)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := reg.ThreadAgent(""); err != nil || got != "agy-neon" {
		t.Fatalf("ThreadAgent(\"\") = %q, %v; want agy-neon", got, err)
	}
}

func TestEveryAgentLeadOnlyIsAnError(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	writeUserRegistry(t, env, `{"version":1,"builtins":"restrict","agents":[
	  {"id":"claude-fable","cli":"claude","model":"fable","lead_only":true}
	]}`)
	reg, err := LoadAgentRegistry(env)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reg.ThreadAgent("claude-fable"); err == nil || !strings.Contains(err.Error(), "thread_agent") {
		t.Fatalf("want an error naming thread_agent, got %v", err)
	}
}
