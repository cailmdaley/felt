package shuttle

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveModelFamily(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	home := t.TempDir()
	env.Set("CODEX_HOME", home)
	cache := `{"models":[
	  {"slug":"gpt-6-sol","visibility":"list"},
	  {"slug":"gpt-6.1-sol","visibility":"list"},
	  {"slug":"gpt-6.10-sol","visibility":"hide"},
	  {"slug":"gpt-5.6-sol","visibility":"list"},
	  {"slug":"gpt-6-luna","visibility":"list"}]}`
	if err := os.WriteFile(filepath.Join(home, "models_cache.json"), []byte(cache), 0o644); err != nil {
		t.Fatal(err)
	}
	pi := t.TempDir()
	env.Set("PI_CODING_AGENT_DIR", pi)
	store := `{"github-copilot":{"models":[{"id":"gpt-6-luna"},{"id":"gpt-6.1-luna"}]},
	  "openai-codex":{"models":[{"id":"gpt-6-sol"},{"id":"gpt-7-sol"}]}}`
	if err := os.WriteFile(filepath.Join(pi, "models-store.json"), []byte(store), 0o644); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		rec  AgentRecord
		want string
	}{
		{AgentRecord{CLI: "codex", Model: "gpt-sol"}, "gpt-6.1-sol"},
		{AgentRecord{CLI: "codex", Model: "gpt-luna"}, "gpt-6-luna"},
		{AgentRecord{CLI: "codex", Model: "gpt-astra"}, "gpt-astra"},
		{AgentRecord{CLI: "codex", Model: "gpt-6-sol"}, "gpt-6-sol"},
		{AgentRecord{CLI: "pi", Provider: "openai-codex", Model: "gpt-sol"}, "gpt-7-sol"},
		{AgentRecord{CLI: "pi", Provider: "github-copilot", Model: "gpt-luna"}, "gpt-6.1-luna"},
		{AgentRecord{CLI: "pi", Provider: "github-copilot", Model: "gpt-sol"}, "gpt-sol"},
		{AgentRecord{CLI: "claude", Model: "opus"}, "opus"},
	}
	for _, c := range cases {
		if got := resolveModelFamily(env, c.rec); got != c.want {
			t.Errorf("%+v = %q, want %q", c.rec, got, c.want)
		}
	}
	env.Set("CODEX_HOME", t.TempDir())
	if got := resolveModelFamily(env, AgentRecord{CLI: "codex", Model: "gpt-sol"}); got != "gpt-sol" {
		t.Errorf("no catalog: got %q", got)
	}
}
