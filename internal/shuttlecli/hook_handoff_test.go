package shuttlecli

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/harness"
	"github.com/cailmdaley/felt/internal/sysenv"
)

func clearHandoffEnv(env *sysenv.Env) {
	for _, key := range []string{"SHUTTLE_HANDOFF_PCT", "SHUTTLE_HANDOFF_TOKENS", "SHUTTLE_HANDOFF_HARD_PCT", "SHUTTLE_HANDOFF_HARD_TOKENS"} {
		env.Unset(key)
	}
}

func codexTokenRow(tokens, window int) string {
	row, _ := json.Marshal(map[string]any{"type": "event_msg", "payload": map[string]any{"type": "token_count", "info": map[string]any{
		"total_token_usage":    map[string]any{"total_tokens": 9_000_000},
		"last_token_usage":     map[string]any{"total_tokens": tokens},
		"model_context_window": window,
	}}})
	return string(row) + "\n"
}

// runHandoff runs the hook once and returns its additionalContext, or "".
func runHandoff(t *testing.T, env *sysenv.Env, transcript string) string {
	t.Helper()
	input, _ := json.Marshal(map[string]any{"session_id": "test", "transcript_path": transcript, "hook_event_name": "PostToolUse"})
	var out bytes.Buffer
	_ = newApp(env).runHandoffHook(bytes.NewReader(input), &out)
	if out.Len() == 0 {
		return ""
	}
	var envelope sessionEnvelope
	if err := json.Unmarshal(out.Bytes(), &envelope); err != nil {
		t.Fatalf("hook output %q: %v", out.String(), err)
	}
	return envelope.HookSpecificOutput.AdditionalContext
}

// handoffCase is one usage and the levels already sent before it.
type handoffCase struct {
	Usage handoffUsage `json:"usage"`
	Sent  []string     `json:"sent"`
}

// nodeHandoffs asks claude-plugin/hooks/lib/handoff.mjs, which Pi's handoff
// uses, what it would say for each case, in one node process.
func nodeHandoffs(t *testing.T, node string, env *sysenv.Env, cases []handoffCase) []string {
	t.Helper()
	lib, err := filepath.Abs(filepath.Join("..", "..", "claude-plugin", "hooks", "lib", "handoff.mjs"))
	if err != nil {
		t.Fatal(err)
	}
	script := `
const fs = await import("node:fs");
const { pathToFileURL } = await import("node:url");
const lib = await import(pathToFileURL(process.argv[1]).href);
const said = JSON.parse(fs.readFileSync(0, "utf8")).map(({ usage, sent }) => {
  try {
    const level = lib.nextHandoff(usage, new Set(sent), lib.handoffThresholds(process.env));
    return level ? lib.handoffMessage(usage, level) : "";
  } catch {
    return "";
  }
});
process.stdout.write(JSON.stringify(said));
`
	cmd := exec.Command(node, "--input-type=module", "-e", script, lib)
	cmd.Env = env.Environ()
	payload, _ := json.Marshal(cases)
	cmd.Stdin = bytes.NewReader(payload)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("node: %v", err)
	}
	var said []string
	if err := json.Unmarshal(out, &said); err != nil || len(said) != len(cases) {
		t.Fatalf("node said %q: %v", out, err)
	}
	return said
}

// The Codex hook and Pi's handoff share thresholds and wording: for the same
// usage, configuration and already-sent levels, Go says what the JS library
// says, one level at a time.
func TestHandoffHookMatchesTheSharedLibrary(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node unavailable")
	}
	configs := []map[string]string{
		{},
		{"SHUTTLE_HANDOFF_PCT": "50"},
		{"SHUTTLE_HANDOFF_TOKENS": "1000", "SHUTTLE_HANDOFF_HARD_TOKENS": "2000"},
		{"SHUTTLE_HANDOFF_PCT": "bad"},
		{"SHUTTLE_HANDOFF_HARD_PCT": "60"},
		{"SHUTTLE_HANDOFF_PCT": "101"},
	}
	steps := []struct{ tokens, window int }{{100_000, 200_000}, {160_000, 200_000}, {190_000, 200_000}, {190_000, 200_000}, {600_000, 0}, {800_000, 0}}
	for _, config := range configs {
		t.Run(strings.TrimSpace(strings.ReplaceAll(strings.Trim(jsonString(config), "{}"), `"`, "")), func(t *testing.T) {
			t.Parallel()
			env, _ := envWithHome(t)
			clearHandoffEnv(env)
			for key, value := range config {
				env.Set(key, value)
			}
			state := t.TempDir()
			env.Set("SHUTTLE_HANDOFF_STATE_DIR", state)
			transcript := filepath.Join(t.TempDir(), "rollout.jsonl")
			var cases []handoffCase
			var said []string
			sent := []string{}
			for _, step := range steps {
				if err := os.WriteFile(transcript, []byte(codexTokenRow(step.tokens, step.window)), 0600); err != nil {
					t.Fatal(err)
				}
				cases = append(cases, handoffCase{handoffUsage{float64(step.tokens), float64(step.window), "codex"}, sent})
				said = append(said, runHandoff(t, env, transcript))
				claims, _ := filepath.Glob(filepath.Join(state, "*", "*"))
				sent = []string{}
				for _, claim := range claims {
					sent = append(sent, filepath.Base(claim))
				}
			}
			for i, want := range nodeHandoffs(t, node, env, cases) {
				if said[i] != want {
					t.Fatalf("%v after %v:\ngo   %q\nnode %q", cases[i].Usage, cases[i].Sent, said[i], want)
				}
			}
		})
	}
}

func jsonString(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func claudeUsageRow(tokens int) string {
	row, _ := json.Marshal(map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "model": "claude-opus", "usage": map[string]any{
		"input_tokens": tokens - 30, "cache_read_input_tokens": 20, "cache_creation_input_tokens": 10, "output_tokens": 5000,
	}}})
	return string(row) + "\n"
}

// claudeTranscript is a session file under Claude Code's transcript tree.
func claudeTranscript(t *testing.T, env *sysenv.Env) string {
	t.Helper()
	root, err := harness.TranscriptRoot(env, "claude")
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "repo")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dir, "s.jsonl")
}

// A Claude Code worker is told once per level, at 350k and 400k tokens, what
// its context is and what to do next; the turns after a level stay quiet.
func TestClaudeWorkerHandoffNudges(t *testing.T) {
	soft := "Context is ~362k tokens (soft threshold 350k). Look for a natural point to update `## Status` and run `shuttle handoff`."
	hard := "Context is ~412k tokens (hard threshold 400k). Finish your current step, update `## Status`, commit, and run `shuttle handoff`."
	cases := []struct {
		name  string
		env   map[string]string
		steps []int
		want  []string
	}{
		{"defaults", nil, []int{100_000, 349_999, 362_000, 360_000, 380_000, 412_000, 410_000, 900_000}, []string{"", "", soft, "", "", hard, "", ""}},
		{"both crossed in one turn", nil, []int{412_000, 412_000, 412_000}, []string{
			"Context is ~412k tokens (soft threshold 350k). Look for a natural point to update `## Status` and run `shuttle handoff`.", hard, ""}},
		{"token overrides", map[string]string{"SHUTTLE_HANDOFF_TOKENS": "1500", "SHUTTLE_HANDOFF_HARD_TOKENS": "200000"}, []int{1_000, 2_000, 150_000, 210_000, 362_000}, []string{"",
			"Context is ~2k tokens (soft threshold 1.5k). Look for a natural point to update `## Status` and run `shuttle handoff`.", "",
			"Context is ~210k tokens (hard threshold 200k). Finish your current step, update `## Status`, commit, and run `shuttle handoff`.", ""}},
		{"hard below soft disables", map[string]string{"SHUTTLE_HANDOFF_TOKENS": "500000"}, []int{362_000, 600_000}, []string{"", ""}},
		{"invalid override disables", map[string]string{"SHUTTLE_HANDOFF_HARD_TOKENS": "lots"}, []int{412_000}, []string{""}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env, _ := envWithHome(t)
			clearHandoffEnv(env)
			env.Set("SHUTTLE_HANDOFF_STATE_DIR", t.TempDir())
			env.Set("SHUTTLE_FIBER_PATH", "/fibers/project/fiber.md")
			for key, value := range tc.env {
				env.Set(key, value)
			}
			transcript := claudeTranscript(t, env)
			for i, tokens := range tc.steps {
				if err := os.WriteFile(transcript, []byte(claudeUsageRow(tokens)), 0600); err != nil {
					t.Fatal(err)
				}
				if got := runHandoff(t, env, transcript); got != tc.want[i] {
					t.Fatalf("at %d tokens:\ngot  %q\nwant %q", tokens, got, tc.want[i])
				}
			}
		})
	}
}

// A Claude session outside a Shuttle worker is never nudged, at any size.
func TestClaudeSessionsOutsideWorkersAreNotNudged(t *testing.T) {
	env, _ := envWithHome(t)
	clearHandoffEnv(env)
	env.Unset("SHUTTLE_FIBER_PATH")
	env.Set("SHUTTLE_HANDOFF_STATE_DIR", t.TempDir())
	transcript := claudeTranscript(t, env)
	if err := os.WriteFile(transcript, []byte(claudeUsageRow(2_000_000)), 0600); err != nil {
		t.Fatal(err)
	}
	if got := runHandoff(t, env, transcript); got != "" {
		t.Fatalf("interactive Claude session nudged: %s", got)
	}
}

// The latest main-thread turn's prompt counts; subagent and synthetic records
// do not, and a compaction since that turn leaves the size unknown.
func TestReadClaudeUsage(t *testing.T) {
	file := filepath.Join(t.TempDir(), "s.jsonl")
	sidechain := `{"type":"assistant","isSidechain":true,"message":{"usage":{"input_tokens":900000}}}` + "\n"
	synthetic := `{"type":"assistant","message":{"model":"<synthetic>","usage":{"input_tokens":0}}}` + "\n"
	compact := `{"type":"system","subtype":"compact_boundary"}` + "\n"
	for _, tc := range []struct {
		body string
		want float64
	}{
		{claudeUsageRow(100_000) + claudeUsageRow(362_000) + sidechain + synthetic + `{"type":"user"}` + "\nbad json\n" + `{"partial":`, 362_000},
		{claudeUsageRow(362_000) + compact, -1},
		{claudeUsageRow(362_000) + compact + claudeUsageRow(40_000), 40_000},
		{claudeUsageRow(362_000) + strings.Repeat("x", handoffTailBytes) + "\n", -1},
	} {
		if err := os.WriteFile(file, []byte(tc.body), 0600); err != nil {
			t.Fatal(err)
		}
		usage, err := readClaudeUsage(file)
		if err != nil || (tc.want < 0) != (usage == nil) || (usage != nil && (usage.Tokens != tc.want || usage.Harness != "claude")) {
			t.Fatalf("want %v, got %+v %v", tc.want, usage, err)
		}
	}
}

func TestHandoffBoundedTail(t *testing.T) {
	file := filepath.Join(t.TempDir(), "transcript")
	if err := os.WriteFile(file, []byte(codexTokenRow(600000, 0)+strings.Repeat("x", handoffTailBytes)+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	usage, err := readCodexUsage(file)
	if err != nil || usage != nil {
		t.Fatalf("%+v %v", usage, err)
	}
	if err := os.WriteFile(file, []byte(codexTokenRow(600000, 0)+"bad json\n"+codexTokenRow(160000, 200000)+`{"partial":`), 0600); err != nil {
		t.Fatal(err)
	}
	usage, err = readCodexUsage(file)
	if err != nil || usage == nil || usage.Tokens != 160000 || usage.ContextWindow != 200000 {
		t.Fatalf("%+v %v", usage, err)
	}
}
