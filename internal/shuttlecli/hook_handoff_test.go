package shuttlecli

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv"
)

func clearHandoffEnv(env *sysenv.Env) {
	for _, key := range []string{"SHUTTLE_HANDOFF_PCT", "SHUTTLE_HANDOFF_TOKENS", "SHUTTLE_HANDOFF_HARD_PCT", "SHUTTLE_HANDOFF_HARD_TOKENS", "SHUTTLE_HANDOFF_CONTEXT_WINDOW"} {
		env.Unset(key)
	}
}

// Keep the Go adapter byte-for-byte compatible with the JS reference used by
// other harnesses, including claims retained across resumes and env overrides.
func TestHandoffHookMatchesNode(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node unavailable")
	}
	for _, row := range []string{
		`{"type":"assistant","message":{"role":"assistant","model":"opus[1m]","usage":{"input_tokens":780000,"cache_read_input_tokens":10000,"output_tokens":1000}}}`,
		`{"type":"assistant","message":{"role":"assistant","usage":{"input_tokens":510000}}}`,
		`{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"total_tokens":190000},"model_context_window":200000}}}`,
		`{"type":"assistant","message":{"role":"assistant","usage":{"input_tokens":-1}}}`,
	} {
		t.Run(row, func(t *testing.T) {
			env, _ := envWithHome(t)
			clearHandoffEnv(env)
			env.Set("SHUTTLE_HANDOFF_STATE_DIR", filepath.Join(t.TempDir(), "go"))
			tr := filepath.Join(t.TempDir(), "transcript.jsonl")
			if err := os.WriteFile(tr, []byte(row+"\n"), 0600); err != nil {
				t.Fatal(err)
			}
			input, _ := json.Marshal(map[string]any{"session_id": "test", "transcript_path": tr, "hook_event_name": "PostToolUse"})
			nodeDir := filepath.Join(t.TempDir(), "node")
			for i := 0; i < 3; i++ {
				var got bytes.Buffer
				if err := newApp(env).runHandoffHook(bytes.NewReader(input), &got); err != nil {
					t.Fatal(err)
				}
				cmd := exec.Command(node, filepath.Join("..", "..", "claude-plugin", "hooks", "handoff.mjs"))
				cmd.Env = append(env.Environ(), "SHUTTLE_HANDOFF_STATE_DIR="+nodeDir)
				cmd.Stdin = bytes.NewReader(input)
				want, err := cmd.Output()
				if err != nil {
					t.Fatal(err)
				}
				if strings.TrimSpace(got.String()) != strings.TrimSpace(string(want)) {
					t.Fatalf("go %s\nnode %s", got.String(), want)
				}
			}
		})
	}
}

func TestClaudeHandoffDefaultsAndOverrides(t *testing.T) {
	for _, tc := range []struct {
		tokens    int
		overrides map[string]string
		want      string
	}{
		{249999, nil, ""}, {250000, nil, "Context is at 250,000"},
		{350000, nil, "HARD CONTEXT LIMIT"},
		{250000, map[string]string{"SHUTTLE_HANDOFF_TOKENS": "300000"}, ""},
		{150000, map[string]string{"SHUTTLE_HANDOFF_CONTEXT_WINDOW": "200000"}, "Context is at 150,000"},
		{500000, map[string]string{"SHUTTLE_HANDOFF_PCT": "101"}, ""},
	} {
		env, _ := envWithHome(t)
		clearHandoffEnv(env)
		env.Set("SHUTTLE_HANDOFF_STATE_DIR", t.TempDir())
		for key, value := range tc.overrides {
			env.Set(key, value)
		}
		tr := filepath.Join(t.TempDir(), "tr")
		row, _ := json.Marshal(map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "usage": map[string]any{"input_tokens": tc.tokens}}})
		if err := os.WriteFile(tr, row, 0600); err != nil {
			t.Fatal(err)
		}
		input, _ := json.Marshal(map[string]any{"session_id": "test", "transcript_path": tr, "hook_event_name": "UserPromptSubmit"})
		var got bytes.Buffer
		a := newApp(env)
		if err := a.runHandoffHook(bytes.NewReader(input), &got); err != nil {
			t.Fatal(err)
		}
		// At the hard boundary, soft is claimed first and hard follows next check.
		if tc.want == "HARD CONTEXT LIMIT" {
			got.Reset()
			if err := a.runHandoffHook(bytes.NewReader(input), &got); err != nil {
				t.Fatal(err)
			}
		}
		if (tc.want == "" && got.Len() != 0) || (tc.want != "" && !strings.Contains(got.String(), tc.want)) {
			t.Fatalf("tokens %d: %s", tc.tokens, got.String())
		}
	}
}

func TestHandoffBoundedTail(t *testing.T) {
	file := filepath.Join(t.TempDir(), "transcript")
	row := `{"type":"assistant","message":{"role":"assistant","usage":{"input_tokens":600000}}}`
	if err := os.WriteFile(file, []byte(row+"\n"+strings.Repeat("x", handoffTailBytes)+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	usage, err := readHandoffUsage(file, nil, "")
	if err != nil || usage != nil {
		t.Fatalf("%+v %v", usage, err)
	}
}
