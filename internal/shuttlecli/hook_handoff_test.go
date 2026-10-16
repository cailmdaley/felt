package shuttlecli

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

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
				cmd.Env = append(os.Environ(), "SHUTTLE_HANDOFF_STATE_DIR="+nodeDir)
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
