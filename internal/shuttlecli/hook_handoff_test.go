package shuttlecli

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/harnesspaths"
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

// nodeHandoff asks claude-plugin/hooks/lib/handoff.mjs, which Pi's handoff
// uses, what it would say for usage after the levels in sent.
func nodeHandoff(t *testing.T, node string, env *sysenv.Env, usage handoffUsage, sent []string) string {
	t.Helper()
	lib, err := filepath.Abs(filepath.Join("..", "..", "claude-plugin", "hooks", "lib", "handoff.mjs"))
	if err != nil {
		t.Fatal(err)
	}
	script := `
const fs = await import("node:fs");
const { pathToFileURL } = await import("node:url");
const lib = await import(pathToFileURL(process.argv[1]).href);
const { usage, sent } = JSON.parse(fs.readFileSync(0, "utf8"));
try {
  const level = lib.nextHandoff(usage, new Set(sent), lib.handoffThresholds(process.env));
  if (level) process.stdout.write(lib.handoffMessage(usage, level));
} catch {}
`
	cmd := exec.Command(node, "--input-type=module", "-e", script, lib)
	cmd.Env = env.Environ()
	payload, _ := json.Marshal(map[string]any{"usage": usage, "sent": sent})
	cmd.Stdin = bytes.NewReader(payload)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("node: %v", err)
	}
	return string(out)
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
			var sent []string
			for _, step := range steps {
				if err := os.WriteFile(transcript, []byte(codexTokenRow(step.tokens, step.window)), 0600); err != nil {
					t.Fatal(err)
				}
				usage := handoffUsage{float64(step.tokens), float64(step.window), "codex"}
				want := nodeHandoff(t, node, env, usage, sent)
				got := runHandoff(t, env, transcript)
				if got != want {
					t.Fatalf("%d/%d after %v:\ngo   %q\nnode %q", step.tokens, step.window, sent, got, want)
				}
				claims, _ := filepath.Glob(filepath.Join(state, "*", "*"))
				sent = sent[:0]
				for _, claim := range claims {
					sent = append(sent, filepath.Base(claim))
				}
			}
		})
	}
}

func jsonString(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// Claude sessions decide their own handoff: their transcripts are not read,
// and a Claude transcript elsewhere holds no Codex usage to nudge on.
func TestClaudeSessionsAreNeverNudged(t *testing.T) {
	env, _ := envWithHome(t)
	clearHandoffEnv(env)
	env.Set("SHUTTLE_HANDOFF_STATE_DIR", t.TempDir())
	env.Set("SHUTTLE_HANDOFF_TOKENS", "1000")
	row, _ := json.Marshal(map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "usage": map[string]any{"input_tokens": 2_000_000}}})
	root, err := harnesspaths.ClaudeProjects(env)
	if err != nil {
		t.Fatal(err)
	}
	projects := filepath.Join(root, "repo")
	if err := os.MkdirAll(projects, 0700); err != nil {
		t.Fatal(err)
	}
	for _, transcript := range []string{filepath.Join(projects, "s.jsonl"), filepath.Join(t.TempDir(), "s.jsonl")} {
		if err := os.WriteFile(transcript, append(row, '\n'), 0600); err != nil {
			t.Fatal(err)
		}
		if got := runHandoff(t, env, transcript); got != "" {
			t.Fatalf("%s: Claude session nudged: %s", transcript, got)
		}
	}
	// Even a token_count row inside Claude's tree is never read.
	if err := os.WriteFile(filepath.Join(projects, "s.jsonl"), []byte(codexTokenRow(2_000_000, 0)), 0600); err != nil {
		t.Fatal(err)
	}
	if got := runHandoff(t, env, filepath.Join(projects, "s.jsonl")); got != "" {
		t.Fatalf("a transcript under Claude's tree was read: %s", got)
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
