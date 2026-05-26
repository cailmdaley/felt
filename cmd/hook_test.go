package cmd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
)

// TestHookSessionEnvelope verifies the SessionStart envelope shape and that
// the additionalContext text matches the format the bash hook emitted: the
// directive line, then either Active Fibers + entries (or "No active fibers"),
// then Recently Touched with truncated outcomes.
func TestHookSessionEnvelope(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	active := &felt.Felt{
		ID:        "alpha",
		Name:      "Alpha task",
		Status:    "active",
		Tags:      []string{"work"},
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
	}
	closedRecent := &felt.Felt{
		ID:        "beta",
		Name:      "Beta finding",
		Status:    "closed",
		Tags:      []string{"finding"},
		CreatedAt: mustParseTime(t, "2026-04-11T09:00:00Z"),
		Outcome:   strings.Repeat("x", 150),
	}
	for _, f := range []*felt.Felt{active, closedRecent} {
		if err := storage.Write(f); err != nil {
			t.Fatalf("Write(%s): %v", f.ID, err)
		}
	}

	out := runHookCommand(t, dir, "hook", "session")

	var env sessionEnvelope
	if err := json.Unmarshal([]byte(out), &env); err != nil {
		t.Fatalf("envelope unmarshal: %v\n%s", err, out)
	}
	if env.HookSpecificOutput.HookEventName != "SessionStart" {
		t.Fatalf("hookEventName = %q, want SessionStart", env.HookSpecificOutput.HookEventName)
	}

	ctx := env.HookSpecificOutput.AdditionalContext
	for _, want := range []string{
		"# Felt Workflow Context",
		"Activate the `felt` skill",
		"## Active Fibers",
		"◐ alpha\n    Alpha task (work)",
		"## Recently Touched",
		"● beta\n    Beta finding (finding)",
		// Outcome truncated to 100 chars + ellipsis.
		"    → " + strings.Repeat("x", 100) + "...",
	} {
		if !strings.Contains(ctx, want) {
			t.Fatalf("context missing %q:\n%s", want, ctx)
		}
	}
}

func TestSessionCommandPrintsPlainContext(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	active := &felt.Felt{
		ID:        "alpha",
		Name:      "Alpha task",
		Status:    "active",
		Tags:      []string{"work"},
		CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z"),
	}
	if err := storage.Write(active); err != nil {
		t.Fatalf("Write(%s): %v", active.ID, err)
	}

	text := runHookCommand(t, dir, "session")
	if !strings.HasPrefix(text, "# Felt Workflow Context\n") {
		t.Fatalf("session should print plain context text, got:\n%s", text)
	}
	if strings.Contains(text, "hookSpecificOutput") || strings.Contains(text, "additionalContext") {
		t.Fatalf("session should not print hook JSON envelope:\n%s", text)
	}
	if !strings.Contains(text, "◐ alpha\n    Alpha task (work)") {
		t.Fatalf("session context missing active fiber:\n%s", text)
	}
}

func TestSessionAttentionWarnsOnFlatTreeAndOpenQueue(t *testing.T) {
	now := mustParseTime(t, "2026-05-26T12:00:00Z")
	var felts []*felt.Felt
	for i := 0; i < sessionTopLevelLimit+1; i++ {
		felts = append(felts, &felt.Felt{
			ID:        fmt.Sprintf("item-%02d", i),
			Name:      fmt.Sprintf("Item %02d", i),
			Status:    felt.StatusOpen,
			CreatedAt: now.Add(-24 * time.Hour),
		})
	}

	attention := buildSessionAttention(felts, now)
	for _, want := range []string{
		"## Attention",
		"Top-level sprawl: 21 root-level fibers (21 without children)",
		"Proactively nest leaf fibers under root buckets",
		"do not leave obvious cleanup for the user",
		"Open queue is large: 21 open fibers",
		"Open/active are todo states",
		"Start with: item-00, item-01, item-02",
	} {
		if !strings.Contains(attention, want) {
			t.Fatalf("attention missing %q:\n%s", want, attention)
		}
	}
}

func TestSessionAttentionWarnsOnTrackedContainers(t *testing.T) {
	now := mustParseTime(t, "2026-05-26T12:00:00Z")
	felts := []*felt.Felt{
		{
			ID:        "root",
			Name:      "Root container",
			Status:    felt.StatusOpen,
			CreatedAt: now.Add(-24 * time.Hour),
		},
		{
			ID:        "root/child",
			Name:      "Child",
			Status:    felt.StatusClosed,
			CreatedAt: now.Add(-24 * time.Hour),
		},
	}

	attention := buildSessionAttention(felts, now)
	for _, want := range []string{
		"Fix tracked containers: 1 open/active fiber has children",
		"Open/active should mean todo, not documentation or importance",
		"demote container fibers unless they represent current work",
		"Review: root",
	} {
		if !strings.Contains(attention, want) {
			t.Fatalf("attention missing %q:\n%s", want, attention)
		}
	}
}

// TestHookSessionNoRepoEnvelope: outside a felt repo, we still emit the
// directive plus a hint to felt init. No "Active Fibers" header.
func TestHookSessionNoRepoEnvelope(t *testing.T) {
	dir := t.TempDir() // no .felt inside

	out := runHookCommand(t, dir, "hook", "session")

	var env sessionEnvelope
	if err := json.Unmarshal([]byte(out), &env); err != nil {
		t.Fatalf("envelope unmarshal: %v\n%s", err, out)
	}
	ctx := env.HookSpecificOutput.AdditionalContext
	if !strings.Contains(ctx, "No felt repository") {
		t.Fatalf("expected no-repo hint:\n%s", ctx)
	}
	if strings.Contains(ctx, "## Active Fibers") {
		t.Fatalf("did not expect Active Fibers section:\n%s", ctx)
	}
}

// TestHookSessionEmptyEnvelope: felt repo exists but no active fibers — we
// emit the no-active marker, not the Active Fibers header.
func TestHookSessionEmptyEnvelope(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	out := runHookCommand(t, dir, "hook", "session")

	var env sessionEnvelope
	if err := json.Unmarshal([]byte(out), &env); err != nil {
		t.Fatalf("envelope unmarshal: %v\n%s", err, out)
	}
	ctx := env.HookSpecificOutput.AdditionalContext
	if !strings.Contains(ctx, "No active fibers") {
		t.Fatalf("expected no-active marker:\n%s", ctx)
	}
}

// TestHookPreToolGate covers the deny/pass matrix that previously lived in
// remind.sh: deny on first non-Skill tool in a felt project, pass on Skill:felt
// (and mark the flag), pass on subsequent tools, pass for Codex sessions, pass
// outside felt repos. Sibling-skill activations (ralph, etc) must not satisfy
// the gate.
func TestHookPreToolGate(t *testing.T) {
	feltDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(feltDir, ".felt"), 0755); err != nil {
		t.Fatalf("mkdir .felt: %v", err)
	}
	plainDir := t.TempDir()

	home := t.TempDir()
	t.Setenv("HOME", home)
	claudeTranscript := filepath.Join(home, ".claude", "projects", "x", "log.jsonl")
	codexTranscript := filepath.Join(t.TempDir(), "codex.jsonl")

	cases := []struct {
		name      string
		input     preToolInput
		expectOut bool   // expect a deny envelope on stdout
		flagFor   string // session id whose flag must exist after; "" = don't check
		noFlagFor string // session id whose flag must NOT exist after
	}{
		{
			name: "first Bash in felt repo denies",
			input: preToolInput{
				SessionID:      "s1",
				ToolName:       "Bash",
				CWD:            feltDir,
				TranscriptPath: claudeTranscript,
			},
			expectOut: true,
			noFlagFor: "s1",
		},
		{
			name: "Skill:felt marks and passes",
			input: preToolInput{
				SessionID:      "s2",
				ToolName:       "Skill",
				CWD:            feltDir,
				TranscriptPath: claudeTranscript,
				ToolInput: struct {
					Skill string `json:"skill"`
				}{Skill: "felt"},
			},
			expectOut: false,
			flagFor:   "s2",
		},
		{
			name: "Skill:felt:felt (namespaced) marks and passes",
			input: preToolInput{
				SessionID:      "s2ns",
				ToolName:       "Skill",
				CWD:            feltDir,
				TranscriptPath: claudeTranscript,
				ToolInput: struct {
					Skill string `json:"skill"`
				}{Skill: "felt:felt"},
			},
			expectOut: false,
			flagFor:   "s2ns",
		},
		{
			name: "Skill:ralph passes WITHOUT marking",
			input: preToolInput{
				SessionID:      "s3",
				ToolName:       "Skill",
				CWD:            feltDir,
				TranscriptPath: claudeTranscript,
				ToolInput: struct {
					Skill string `json:"skill"`
				}{Skill: "ralph"},
			},
			expectOut: false,
			noFlagFor: "s3",
		},
		{
			name: "codex transcript path marks and passes",
			input: preToolInput{
				SessionID:      "s4",
				ToolName:       "Bash",
				CWD:            feltDir,
				TranscriptPath: codexTranscript,
			},
			expectOut: false,
			flagFor:   "s4",
		},
		{
			name: "no .felt at cwd: pass silently",
			input: preToolInput{
				SessionID:      "s5",
				ToolName:       "Bash",
				CWD:            plainDir,
				TranscriptPath: claudeTranscript,
			},
			expectOut: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Clean flag files used in this case.
			for _, sid := range []string{tc.flagFor, tc.noFlagFor, tc.input.SessionID} {
				if sid != "" {
					_ = os.Remove(filepath.Join(os.TempDir(), "felt-reminded-"+sid))
				}
			}

			out := runPreToolWithInput(t, tc.input)

			if tc.expectOut {
				if !strings.Contains(out, "\"permissionDecision\": \"deny\"") {
					t.Fatalf("expected deny envelope, got:\n%s", out)
				}
			} else {
				if strings.TrimSpace(out) != "" {
					t.Fatalf("expected silent pass, got:\n%s", out)
				}
			}

			if tc.flagFor != "" {
				if _, err := os.Stat(filepath.Join(os.TempDir(), "felt-reminded-"+tc.flagFor)); err != nil {
					t.Fatalf("expected flag file for %s: %v", tc.flagFor, err)
				}
			}
			if tc.noFlagFor != "" {
				if _, err := os.Stat(filepath.Join(os.TempDir(), "felt-reminded-"+tc.noFlagFor)); err == nil {
					t.Fatalf("did not expect flag file for %s", tc.noFlagFor)
				}
			}
		})
	}
}

// TestHookPreToolFlagPersists: once the flag is set, a subsequent non-Skill
// tool call passes silently.
func TestHookPreToolFlagPersists(t *testing.T) {
	feltDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(feltDir, ".felt"), 0755); err != nil {
		t.Fatalf("mkdir .felt: %v", err)
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	claudeTranscript := filepath.Join(home, ".claude", "projects", "x", "log.jsonl")

	sid := "persist-test"
	_ = os.Remove(filepath.Join(os.TempDir(), "felt-reminded-"+sid))

	// Activate felt skill: marks flag, no output.
	out := runPreToolWithInput(t, preToolInput{
		SessionID:      sid,
		ToolName:       "Skill",
		CWD:            feltDir,
		TranscriptPath: claudeTranscript,
		ToolInput: struct {
			Skill string `json:"skill"`
		}{Skill: "felt"},
	})
	if strings.TrimSpace(out) != "" {
		t.Fatalf("Skill:felt should pass silently, got: %s", out)
	}

	// Subsequent Bash: silent pass.
	out = runPreToolWithInput(t, preToolInput{
		SessionID:      sid,
		ToolName:       "Bash",
		CWD:            feltDir,
		TranscriptPath: claudeTranscript,
	})
	if strings.TrimSpace(out) != "" {
		t.Fatalf("post-activation Bash should pass silently, got: %s", out)
	}
}

// --- helpers ---

func runHookCommand(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := runCommand(t, dir, args...)
	if err != nil {
		t.Fatalf("%v: %v\n%s", args, err, out)
	}
	return out
}

// runPreToolWithInput invokes runPreToolHook directly with a constructed
// payload — easier than wiring stdin through the cobra layer in tests.
func runPreToolWithInput(t *testing.T, input preToolInput) string {
	t.Helper()

	payload, err := json.Marshal(input)
	if err != nil {
		t.Fatalf("marshal input: %v", err)
	}

	stdinR, stdinW, err := os.Pipe()
	if err != nil {
		t.Fatalf("stdin pipe: %v", err)
	}
	if _, err := stdinW.Write(payload); err != nil {
		t.Fatalf("write stdin: %v", err)
	}
	stdinW.Close()

	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}
	defer stdoutR.Close()

	done := make(chan struct{})
	var buf bytes.Buffer
	go func() {
		_, _ = buf.ReadFrom(stdoutR)
		close(done)
	}()

	if err := runPreToolHook(stdinR, stdoutW); err != nil {
		t.Fatalf("runPreToolHook: %v", err)
	}
	stdoutW.Close()
	<-done
	return buf.String()
}
