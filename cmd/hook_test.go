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
// directive line, then either Active / Open + entries (or the empty marker),
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
	// Head line carries the recency timestamp (no events here, so recency falls
	// back to created-at), rendered with the same local format as the hook.
	alphaHead := active.CreatedAt.Local().Format("2006-01-02 15:04") + " — alpha"
	betaHead := closedRecent.CreatedAt.Local().Format("2006-01-02 15:04") + " — beta"
	for _, want := range []string{
		"# Felt Workflow Context",
		"Activate the `felt` skill",
		"## Active / Open",
		"◐ " + alphaHead + "\n    Alpha task (work)",
		"## Recently Touched",
		"● " + betaHead + "\n    Beta finding (finding)",
		// Outcome truncated to 100 chars + ellipsis.
		"    → " + strings.Repeat("x", 100) + "...",
	} {
		if !strings.Contains(ctx, want) {
			t.Fatalf("context missing %q:\n%s", want, ctx)
		}
	}
}

// TestSessionSectionPlacement: active and open fibers land in Active / Open;
// closed and untracked fibers land in Recently Touched. A fiber appears in at
// most one section.
func TestSessionSectionPlacement(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	base := mustParseTime(t, "2026-04-10T09:00:00Z")
	fibers := []*felt.Felt{
		{ID: "act", Name: "Active one", Status: felt.StatusActive, CreatedAt: base},
		{ID: "opn", Name: "Open one", Status: felt.StatusOpen, CreatedAt: base.Add(time.Hour)},
		{ID: "cls", Name: "Closed one", Status: felt.StatusClosed, CreatedAt: base.Add(2 * time.Hour)},
		{ID: "unt", Name: "Untracked one", CreatedAt: base.Add(3 * time.Hour)},
	}
	for _, f := range fibers {
		if err := storage.Write(f); err != nil {
			t.Fatalf("Write(%s): %v", f.ID, err)
		}
	}

	ctx := sessionContextFor(t, dir)
	inFlightSec, recentSec := splitSections(ctx)

	for _, id := range []string{"act", "opn"} {
		if !strings.Contains(inFlightSec, id) {
			t.Fatalf("%s missing from Active / Open:\n%s", id, inFlightSec)
		}
		if strings.Contains(recentSec, " "+id+"\n") {
			t.Fatalf("in-flight fiber %s leaked into Recently Touched:\n%s", id, recentSec)
		}
	}
	for _, id := range []string{"cls", "unt"} {
		if strings.Contains(inFlightSec, " "+id+"\n") {
			t.Fatalf("remaining fiber %s leaked into Active / Open:\n%s", id, inFlightSec)
		}
		if !strings.Contains(recentSec, id) {
			t.Fatalf("%s missing from Recently Touched:\n%s", id, recentSec)
		}
	}
}

// TestSessionRecencyOrdering: sections sort by the git-durable RecencyAnchor
// (updated-at when present, else created-at) DESC — never file mtime.
func TestSessionRecencyOrdering(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	// Three closed fibers, created oldest→newest as old/mid/noev. We give `old`
	// the newest updated-at so the durable anchor overrides created-at ordering;
	// `noev` has no updated-at and must fall back to its created-at. Active/open
	// fibers use the same ordering signal across status boundaries.
	base := mustParseTime(t, "2026-04-01T00:00:00Z")
	stamp := func(f *felt.Felt, at time.Time) *felt.Felt { f.Touch(at); return f }
	fibers := []*felt.Felt{
		stamp(&felt.Felt{ID: "old", Name: "Old", Status: felt.StatusClosed, CreatedAt: base}, mustParseTime(t, "2026-06-01T00:00:00Z")),
		stamp(&felt.Felt{ID: "mid", Name: "Mid", Status: felt.StatusClosed, CreatedAt: base.Add(24 * time.Hour)}, mustParseTime(t, "2026-05-01T00:00:00Z")),
		{ID: "noev", Name: "No update", Status: felt.StatusClosed, CreatedAt: base.Add(48 * time.Hour)},
		stamp(&felt.Felt{ID: "active", Name: "Active", Status: felt.StatusActive, CreatedAt: base}, mustParseTime(t, "2026-05-01T00:00:00Z")),
		stamp(&felt.Felt{ID: "open", Name: "Open", Status: felt.StatusOpen, CreatedAt: base.Add(24 * time.Hour)}, mustParseTime(t, "2026-06-01T00:00:00Z")),
	}
	for _, f := range fibers {
		if err := storage.Write(f); err != nil {
			t.Fatalf("Write(%s): %v", f.ID, err)
		}
	}

	ctx := sessionContextFor(t, dir)
	inFlightSec := mustSection(t, ctx, "## Active / Open")
	recentSec := mustSection(t, ctx, "## Recently Touched")
	assertOrder(t, inFlightSec, "open", "active")
	// Expected order: old (updated 06-01) > mid (updated 05-01) > noev (created 04-03).
	assertOrder(t, recentSec, "old", "mid", "noev")
}

// TestSessionHeadShowsRecencyTimestamp: the head line carries the recency
// timestamp (updated-at) rendered in local time, so the visible label matches
// the sort key — and shows the update time, not the fiber's created-at.
func TestSessionHeadShowsRecencyTimestamp(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	created := mustParseTime(t, "2026-04-01T00:00:00Z")
	gamma := &felt.Felt{ID: "gamma", Name: "Gamma", Status: felt.StatusActive, CreatedAt: created}
	// An update a month after creation: the head must show the update time, not
	// the created-at fallback.
	touched := mustParseTime(t, "2026-05-15T14:30:00Z")
	gamma.Touch(touched)
	if err := storage.Write(gamma); err != nil {
		t.Fatalf("Write(gamma): %v", err)
	}

	ctx := sessionContextFor(t, dir)
	if want := "◐ " + touched.Local().Format("2006-01-02 15:04") + " — gamma"; !strings.Contains(ctx, want) {
		t.Fatalf("head missing recency timestamp %q:\n%s", want, ctx)
	}
	if bad := created.Local().Format("2006-01-02 15:04") + " — gamma"; strings.Contains(ctx, bad) {
		t.Fatalf("head used created-at instead of event recency:\n%s", ctx)
	}
}

// TestSessionSectionCaps: each section renders at most five fibers even when
// more qualify.
func TestSessionSectionCaps(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	base := mustParseTime(t, "2026-04-01T00:00:00Z")
	for i := 0; i < 15; i++ {
		at := base.Add(time.Duration(i) * time.Hour)
		if err := storage.Write(&felt.Felt{
			ID:        fmt.Sprintf("tracked-%02d", i),
			Name:      fmt.Sprintf("Tracked %02d", i),
			Status:    []string{felt.StatusActive, felt.StatusOpen}[i%2],
			CreatedAt: at,
		}); err != nil {
			t.Fatalf("Write tracked-%02d: %v", i, err)
		}
		if err := storage.Write(&felt.Felt{
			ID:        fmt.Sprintf("closed-%02d", i),
			Name:      fmt.Sprintf("Closed %02d", i),
			Status:    felt.StatusClosed,
			CreatedAt: at,
		}); err != nil {
			t.Fatalf("Write closed-%02d: %v", i, err)
		}
	}

	ctx := sessionContextFor(t, dir)
	// The slug now follows the recency timestamp + " — " separator on the head
	// line, so count by that separator rather than the bare icon.
	if got := strings.Count(ctx, " — tracked-"); got != sessionSectionLimit {
		t.Fatalf("active/open entries shown = %d, want %d:\n%s", got, sessionSectionLimit, ctx)
	}
	if got := strings.Count(ctx, " — closed-"); got != sessionSectionLimit {
		t.Fatalf("recently-touched entries shown = %d, want %d:\n%s", got, sessionSectionLimit, ctx)
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
	wantHead := "◐ " + active.CreatedAt.Local().Format("2006-01-02 15:04") + " — alpha"
	if !strings.Contains(text, wantHead+"\n    Alpha task (work)") {
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
// directive plus a hint to felt init. No "Active / Open" header.
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
	if strings.Contains(ctx, "## Active / Open") {
		t.Fatalf("did not expect Active / Open section:\n%s", ctx)
	}
}

// TestHookSessionEmptyEnvelope: felt repo exists but no active or open fibers
// — we emit the empty marker, not the Active / Open header.
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
	if !strings.Contains(ctx, "No active or open fibers") {
		t.Fatalf("expected no-active-or-open marker:\n%s", ctx)
	}
}

// TestHookPreToolGate covers the deny/pass matrix that previously lived in
// remind.sh: deny on first non-Skill tool in a felt project, pass on Skill:felt
// (and mark the flag), pass on subsequent tools, pass for Codex sessions, pass
// outside felt repos. Sibling-skill activations (shuttle, etc) must not satisfy
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
			name: "Skill:shuttle passes WITHOUT marking",
			input: preToolInput{
				SessionID:      "s3",
				ToolName:       "Skill",
				CWD:            feltDir,
				TranscriptPath: claudeTranscript,
				ToolInput: struct {
					Skill string `json:"skill"`
				}{Skill: "shuttle"},
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

// sessionContextFor runs `felt session` and returns the plain context text.
func sessionContextFor(t *testing.T, dir string) string {
	t.Helper()
	return runHookCommand(t, dir, "session")
}

// splitSections returns the Active / Open and Recently Touched slices of a
// session context, each bounded by the next "## " header.
func splitSections(ctx string) (inFlight, recent string) {
	return sectionBody(ctx, "## Active / Open"), sectionBody(ctx, "## Recently Touched")
}

func mustSection(t *testing.T, ctx, header string) string {
	t.Helper()
	body := sectionBody(ctx, header)
	if body == "" {
		t.Fatalf("section %q missing:\n%s", header, ctx)
	}
	return body
}

func sectionBody(ctx, header string) string {
	start := strings.Index(ctx, header)
	if start < 0 {
		return ""
	}
	rest := ctx[start+len(header):]
	if next := strings.Index(rest, "\n## "); next >= 0 {
		return rest[:next]
	}
	return rest
}

// assertOrder checks that the given ids appear in the section in the listed
// order (by first occurrence).
func assertOrder(t *testing.T, section string, ids ...string) {
	t.Helper()
	prev := -1
	for _, id := range ids {
		at := strings.Index(section, id)
		if at < 0 {
			t.Fatalf("id %q absent from section:\n%s", id, section)
		}
		if at < prev {
			t.Fatalf("id %q out of order (want order %v):\n%s", id, ids, section)
		}
		prev = at
	}
}

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

// runPostToolWithInput invokes runPostToolHook directly with a constructed
// PostToolUse payload.
func runPostToolWithInput(t *testing.T, input postToolInput) {
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
	if err := runPostToolHook(stdinR); err != nil {
		t.Fatalf("runPostToolHook: %v", err)
	}
}

func postEditInput(tool, filePath string) postToolInput {
	in := postToolInput{ToolName: tool}
	in.ToolInput.FilePath = filePath
	return in
}

func TestPostToolHookStampsDirectFiberEdit(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	created := mustParseTime(t, "2026-04-10T09:00:00Z")
	if err := storage.Write(&felt.Felt{ID: "alpha", Name: "Alpha", CreatedAt: created}); err != nil {
		t.Fatalf("Write: %v", err)
	}

	// An agent edits the fiber's markdown directly (not via `felt edit`).
	runPostToolWithInput(t, postEditInput("Edit", storage.Path("alpha")))

	f, err := storage.Read("alpha")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if f.UpdatedAt == nil || !f.UpdatedAt.After(created) {
		t.Fatalf("direct edit did not stamp updated-at: %v", f.UpdatedAt)
	}
}

func TestPostToolHookStampsCompanionEdit(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	created := mustParseTime(t, "2026-04-10T09:00:00Z")
	if err := storage.Write(&felt.Felt{ID: "beta", Name: "Beta", CreatedAt: created}); err != nil {
		t.Fatalf("Write: %v", err)
	}

	// Editing a companion file (report.html) inside the fiber dir is work on
	// the fiber, so it advances recency too.
	companion := filepath.Join(filepath.Dir(storage.Path("beta")), "report.html")
	runPostToolWithInput(t, postEditInput("Write", companion))

	f, err := storage.Read("beta")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if f.UpdatedAt == nil || !f.UpdatedAt.After(created) {
		t.Fatalf("companion edit did not stamp updated-at: %v", f.UpdatedAt)
	}
}

func TestPostToolHookIgnoresNonEditAndNonFelt(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	created := mustParseTime(t, "2026-04-10T09:00:00Z")
	if err := storage.Write(&felt.Felt{ID: "gamma", Name: "Gamma", CreatedAt: created}); err != nil {
		t.Fatalf("Write: %v", err)
	}

	// A non-edit tool on the fiber file: no stamp.
	runPostToolWithInput(t, postEditInput("Read", storage.Path("gamma")))
	// An edit on a file outside any felt store: no stamp, no error.
	runPostToolWithInput(t, postEditInput("Edit", filepath.Join(dir, "code.go")))

	f, err := storage.Read("gamma")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if f.UpdatedAt != nil {
		t.Fatalf("expected no stamp from non-edit/non-felt tool calls, got %v", f.UpdatedAt)
	}
}

func TestFiberFromEditedPath(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	if err := storage.Write(&felt.Felt{ID: "root-fiber", Name: "Root"}); err != nil {
		t.Fatalf("Write root: %v", err)
	}
	if err := storage.Write(&felt.Felt{ID: "a/b/nested", Name: "Nested"}); err != nil {
		t.Fatalf("Write nested: %v", err)
	}

	cases := []struct {
		name   string
		path   string
		wantID string
		wantOK bool
	}{
		{"nested fiber md", storage.Path("a/b/nested"), "a/b/nested", true},
		{"companion in nested dir", filepath.Join(filepath.Dir(storage.Path("a/b/nested")), "plot.png"), "a/b/nested", true},
		{"non-fiber dir under .felt", filepath.Join(dir, ".felt", "a", "b", "loose.md"), "", false},
		{"outside any store", filepath.Join(dir, "src", "main.go"), "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotRoot, gotID, ok := fiberFromEditedPath(tc.path)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v (id=%q)", ok, tc.wantOK, gotID)
			}
			if !ok {
				return
			}
			if gotID != tc.wantID {
				t.Fatalf("id = %q, want %q", gotID, tc.wantID)
			}
			if gotRoot != dir {
				t.Fatalf("root = %q, want %q", gotRoot, dir)
			}
		})
	}
}
