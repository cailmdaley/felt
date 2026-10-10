package shuttle

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestAgentEnvValidation(t *testing.T) {
	t.Parallel()
	for _, envJSON := range []string{`{"":"v"}`, `{"1BAD":"v"}`, `{"BAD-NAME":"v"}`, `{"BAD=NAME":"v"}`, `{"é":"v"}`, `{"OK":1}`, `{"OK":null}`, `{"OK":true}`, `{"OK":"\u0000"}`, `[]`, `"value"`, `null`} {
		for _, envelope := range []bool{false, true} {
			data := `[{"id":"custom","cli":"claude","env":` + envJSON + `}]`
			if envelope {
				data = `{"version":1,"agents":` + data + `}`
			}
			_, _, err := parseAgentsFile([]byte(data), "/registry/agents.json")
			if err == nil || !strings.Contains(err.Error(), "/registry/agents.json") {
				t.Errorf("env %s (envelope %v): expected path-bearing error, got %v", envJSON, envelope, err)
			}
		}
	}
}

func TestAgentEnvResolveAndWholesaleMerge(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	writeUserRegistry(t, env, `{"agents":[
 {"id":"claude-opus","cli":"claude","model":"opus","env":{"CLAUDE_CODE_PROMPT_CACHE_TTL":"5m","_EMPTY":"","Mixed_1":"a' $b\n"}},
 {"id":"custom-alias","alias_of":"claude-opus","env":{"Mixed_1":"alias"}}
 ]}`)
	reg, err := LoadAgentRegistry(env)
	if err != nil {
		t.Fatal(err)
	}
	want := AgentEnv{"CLAUDE_CODE_PROMPT_CACHE_TTL": "5m", "_EMPTY": "", "Mixed_1": "a' $b\n"}
	rec, axes, err := reg.Resolve("claude-opus", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if rec.ExtraFlags != "" {
		t.Fatal("user record must replace built-in wholesale")
	}
	resolved := reg.NewResolvedAgent(rec, axes)
	block, err := ResolveBlock(&Block{Agent: "claude-opus"}, reg, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(resolved.Env, want) || !reflect.DeepEqual(block.Agent.Env, want) {
		t.Fatalf("resolved env: %+v / %+v", resolved, block)
	}
	data, err := json.Marshal(resolved)
	if err != nil {
		t.Fatal(err)
	}
	var output struct {
		Env map[string]string `json:"env"`
	}
	if err := json.Unmarshal(data, &output); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(output.Env, map[string]string(want)) {
		t.Fatalf("JSON env: %s", data)
	}
	alias, _, err := reg.Resolve("custom-alias", "", false)
	if err != nil || alias.ID != "custom-alias" || alias.Env["Mixed_1"] != "alias" || alias.Env["_EMPTY"] != "" {
		t.Fatalf("alias env: %+v, %v", alias, err)
	}
	// Launch metadata records the resolved id. Resolving that id on resume
	// or capture must preserve an alias's environment overrides.
	persisted := reg.NewResolvedAgent(alias, Axes{})
	resumed, _, err := reg.Resolve(persisted.ID, "", false)
	if err != nil || !reflect.DeepEqual(resumed.Env, alias.Env) {
		t.Fatalf("persisted alias env: %+v, %v", resumed, err)
	}
	if !reflect.DeepEqual(find(t, reg, "claude-opus").Env, want) {
		t.Fatal("alias resolution mutated base env")
	}
	merged, _ := mergeAgentLayers([]AgentRecord{rec}, []AgentRecord{{ID: rec.ID, CLI: "claude"}}, BuiltinsMerge)
	if len(merged) != 1 || len(merged[0].Env) != 0 {
		t.Fatalf("replacement inherited env: %+v", merged)
	}
}
