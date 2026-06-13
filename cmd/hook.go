package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var sessionCmd = &cobra.Command{
	Use:   "session",
	Short: "Print the session context text",
	Long: `Print the plain text context that felt contributes at agent session
start: the activation directive plus active and recently touched fibers.

Hook adapters wrap this text in whatever envelope their harness expects. For
Claude/Codex's current SessionStart wire format, see ` + "`felt hook session`" + `.`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		fmt.Print(buildSessionContext())
		return nil
	},
}

// The bundled Claude Code plugin's hook scripts call these subcommands only at
// the harness boundary. Keep the human-facing session context available as
// plain text via `felt session`; `felt hook ...` is integration glue and may
// emit machine envelopes.
var hookCmd = &cobra.Command{
	Use:   "hook",
	Short: "Integration hooks (plugin glue; see claude-plugin/hooks/)",
	Long: `Hook subcommands emit the machine envelopes expected by agent harnesses.
They are adapter commands, not the primary human-facing felt surface. Use
` + "`felt session`" + ` to inspect the SessionStart context as readable text.`,
}

type sessionEnvelope struct {
	HookSpecificOutput sessionInner `json:"hookSpecificOutput"`
}
type sessionInner struct {
	HookEventName     string `json:"hookEventName"`
	AdditionalContext string `json:"additionalContext"`
}

var hookSessionCmd = &cobra.Command{
	Use:   "session",
	Short: "Emit the SessionStart additionalContext envelope",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		envelope := sessionEnvelope{HookSpecificOutput: sessionInner{
			HookEventName:     "SessionStart",
			AdditionalContext: buildSessionContext(),
		}}
		return encodeHookJSON(os.Stdout, envelope)
	},
}

// encodeHookJSON writes indented JSON without HTML-escaping `<>&`. The bash
// hooks shelled out to jq, which doesn't escape by default; Go's encoder does.
// The wire is semantically equivalent either way but the unescaped form reads
// more cleanly in logs and matches the historical output byte-for-byte where
// fiber bodies contain angle brackets.
func encodeHookJSON(w *os.File, v interface{}) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	return enc.Encode(v)
}

var hookPreToolCmd = &cobra.Command{
	Use:   "pretool",
	Short: "PreToolUse gate: deny non-felt tool calls until the felt skill is activated",
	Long: `Reads the PreToolUse payload from stdin and emits either a deny envelope
(if the felt skill hasn't been activated this session in a felt-enabled
project) or nothing (pass through). Outside felt-enabled projects, or in
non-Claude sessions like Codex, this is a pass-through.`,
	Args:         cobra.NoArgs,
	SilenceUsage: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		return runPreToolHook(os.Stdin, os.Stdout)
	},
}

func init() {
	rootCmd.AddCommand(sessionCmd)
	rootCmd.AddCommand(hookCmd)
	hookCmd.AddCommand(hookSessionCmd)
	hookCmd.AddCommand(hookPreToolCmd)
}

// ----------------------------------------------------------------------------
// SessionStart context
// ----------------------------------------------------------------------------

const sessionDirective = "**Activate the `felt` skill before any tool or action — every session, even when the user's request seems unrelated to felt.** The skill body carries the practice (philosophy, CLI, references). Reading this context is not the same as having the skill loaded."

const sessionNoRepoNote = "*No felt repository in current directory. Start one with `felt init` when this conversation produces thinking worth keeping.*"

const sessionNoActiveNote = "*No active fibers.*"

const (
	// sessionActiveLimit is the Attention threshold for "active set is broad"
	// — it gates the advisory note, not the display. Distinct from the display
	// cap below.
	sessionActiveLimit = 3
	// sessionActiveDisplayLimit caps how many active fibers the Active Fibers
	// section renders.
	sessionActiveDisplayLimit = 10
	// sessionRecentLimit caps the Recently Touched section.
	sessionRecentLimit   = 10
	sessionOpenLimit     = 20
	sessionTopLevelLimit = 20
	sessionStaleAge      = 30 * 24 * time.Hour
)

// buildSessionContext renders the markdown additionalContext text. Mirrors the
// shape the previous bash hook emitted; tests in cmd/hook_test.go pin the
// output so a wording or layout change is a deliberate diff.
func buildSessionContext() string {
	var sb strings.Builder
	sb.WriteString("# Felt Workflow Context\n\n")
	sb.WriteString(sessionDirective)
	sb.WriteString("\n\n")

	root, err := resolveProjectRoot()
	if err != nil || root == "" {
		sb.WriteString(sessionNoRepoNote)
		sb.WriteString("\n")
		return sb.String()
	}

	storage := felt.NewStorage(root)
	felts, err := storage.ListMetadata()
	if err != nil {
		// Storage error: surface it in-band rather than crashing the hook.
		fmt.Fprintf(&sb, "*felt listing failed: %s*\n", err)
		return sb.String()
	}

	// Recency signal comes from the content-hash-anchored history log
	// (MAX(occurred_at) per fiber), not file mtime — felt is git-synced
	// across machines, so any clone/checkout/reorg rewrites every file and
	// flattens all mtimes to one instant. The history log survives that.
	// Reading is a best-effort read-only cache lookup: a missing or busy
	// index just leaves the map empty, and recency falls back to created-at.
	latest := loadLatestEventTimes(storage)
	recency := func(f *felt.Felt) time.Time {
		if t, ok := latest[f.ID]; ok {
			return t
		}
		return f.CreatedAt
	}
	byRecencyDesc := func(fs []*felt.Felt) {
		sort.SliceStable(fs, func(i, j int) bool {
			return recency(fs[i]).After(recency(fs[j]))
		})
	}

	// Active fibers: status == active, newest history first, capped.
	var active []*felt.Felt
	for _, f := range felts {
		if f.IsActive() {
			active = append(active, f)
		}
	}
	byRecencyDesc(active)
	if len(active) > sessionActiveDisplayLimit {
		active = active[:sessionActiveDisplayLimit]
	}

	if len(active) > 0 {
		sb.WriteString("## Active Fibers\n\n")
		for _, f := range active {
			sb.WriteString(formatHookEntry(f, false))
		}
		sb.WriteString("\n")
	} else {
		sb.WriteString(sessionNoActiveNote)
		sb.WriteString("\n\n")
	}

	// Recently touched: everything not active (open/closed/untracked), newest
	// history first, capped. A fiber is in at most one section.
	var recent []*felt.Felt
	for _, f := range felts {
		if !f.IsActive() {
			recent = append(recent, f)
		}
	}
	byRecencyDesc(recent)
	if len(recent) > sessionRecentLimit {
		recent = recent[:sessionRecentLimit]
	}
	if len(recent) > 0 {
		sb.WriteString("## Recently Touched\n\n")
		for _, f := range recent {
			sb.WriteString(formatHookEntry(f, true))
		}
		sb.WriteString("\n")
	}

	if attention := buildSessionAttention(felts, time.Now()); attention != "" {
		sb.WriteString(attention)
		sb.WriteString("\n")
	}

	return sb.String()
}

// loadLatestEventTimes returns MAX(occurred_at) per fiber from the history
// log, or an empty map when the index is missing/busy. The SessionStart hook
// is a read path: a stale or absent cache must degrade to created-at ordering,
// never error or force a full index sync.
func loadLatestEventTimes(storage *felt.Storage) map[string]time.Time {
	idx, err := storage.OpenIndexReadOnly()
	if err != nil {
		return map[string]time.Time{}
	}
	defer idx.Close()
	latest, err := idx.LatestEventTimes()
	if err != nil {
		return map[string]time.Time{}
	}
	return latest
}

// formatHookEntry renders one fiber for the SessionStart context. Active
// entries get the two-line form (icon + id, then indented name + tags).
// Recently-touched entries add a third line with a truncated outcome.
func formatHookEntry(f *felt.Felt, withOutcome bool) string {
	icon := felt.StatusIcon(f.Status)
	line1 := fmt.Sprintf("%s %s\n", icon, f.ID)

	tagStr := ""
	if len(f.Tags) > 0 {
		tagStr = fmt.Sprintf(" (%s)", strings.Join(f.Tags, ", "))
	}
	line2 := fmt.Sprintf("    %s%s\n", f.DisplayName(), tagStr)

	if !withOutcome || f.Outcome == "" {
		return line1 + line2
	}

	outcome := strings.TrimSpace(f.Outcome)
	// Match the previous hook's one-line outcome treatment: collapse internal
	// whitespace and truncate at 100 chars with ellipsis.
	outcome = strings.Join(strings.Fields(outcome), " ")
	if len(outcome) > 100 {
		outcome = outcome[:100] + "..."
	}
	line3 := fmt.Sprintf("    → %s\n", outcome)
	return line1 + line2 + line3
}

func buildSessionAttention(felts []*felt.Felt, now time.Time) string {
	childrenByParent := make(map[string]int)
	for _, f := range felts {
		parts := strings.Split(f.ID, "/")
		for i := 1; i < len(parts); i++ {
			childrenByParent[strings.Join(parts[:i], "/")]++
		}
	}

	var active, open, staleTracked, trackedContainers, topLevel, topLevelLeaves []*felt.Felt
	for _, f := range felts {
		switch f.Status {
		case felt.StatusActive:
			active = append(active, f)
			if isStaleSessionFiber(f, now) {
				staleTracked = append(staleTracked, f)
			}
			if childrenByParent[f.ID] > 0 {
				trackedContainers = append(trackedContainers, f)
			}
		case felt.StatusOpen:
			open = append(open, f)
			if isStaleSessionFiber(f, now) {
				staleTracked = append(staleTracked, f)
			}
			if childrenByParent[f.ID] > 0 {
				trackedContainers = append(trackedContainers, f)
			}
		}

		if !strings.Contains(f.ID, "/") {
			topLevel = append(topLevel, f)
			if childrenByParent[f.ID] == 0 {
				topLevelLeaves = append(topLevelLeaves, f)
			}
		}
	}

	sortFibersByCreatedAt(active)
	sortFibersByCreatedAt(open)
	sortFibersByCreatedAt(staleTracked)
	sortFibersByCreatedAt(trackedContainers)
	sortFibersByCreatedAt(topLevelLeaves)

	var notes []string
	if len(topLevel) > sessionTopLevelLimit {
		notes = append(notes, fmt.Sprintf(
			"Top-level sprawl: %d root-level fibers (%d without children). Proactively nest leaf fibers under root buckets or create broader categories; do not leave obvious cleanup for the user. Start with: %s.",
			len(topLevel), len(topLevelLeaves), formatSessionExamples(topLevelLeaves),
		))
	}
	if len(trackedContainers) > 0 {
		notes = append(notes, fmt.Sprintf(
			"Fix tracked containers: %d open/active %s %s children. Open/active should mean todo, not documentation or importance; demote container fibers unless they represent current work. Review: %s.",
			len(trackedContainers), pluralize(len(trackedContainers), "fiber", "fibers"), pluralize(len(trackedContainers), "has", "have"), formatSessionExamples(trackedContainers),
		))
	}
	if len(active) > sessionActiveLimit {
		notes = append(notes, fmt.Sprintf(
			"Active set is broad: %d active fibers. Keep active for current attention; close or demote stale work without waiting for user prompting. Start with: %s.",
			len(active), formatSessionExamples(active),
		))
	}
	if len(open) > sessionOpenLimit {
		notes = append(notes, fmt.Sprintf(
			"Open queue is large: %d open fibers. Open/active are todo states; close, demote, or consolidate stale intent proactively. Start with: %s.",
			len(open), formatSessionExamples(open),
		))
	}
	if len(staleTracked) > 0 {
		notes = append(notes, fmt.Sprintf(
			"Tracked fibers are old: %d open/active fibers are older than 30 days. Review status before trusting the queue. Start with: %s.",
			len(staleTracked), formatSessionExamples(staleTracked),
		))
	}

	if len(notes) == 0 {
		return ""
	}
	if len(notes) > 3 {
		notes = notes[:3]
	}

	var sb strings.Builder
	sb.WriteString("## Attention\n\n")
	for _, note := range notes {
		sb.WriteString(note)
		sb.WriteString("\n\n")
	}
	return sb.String()
}

func isStaleSessionFiber(f *felt.Felt, now time.Time) bool {
	return !f.CreatedAt.IsZero() && now.Sub(f.CreatedAt) > sessionStaleAge
}

func sortFibersByCreatedAt(felts []*felt.Felt) {
	sort.Slice(felts, func(i, j int) bool {
		return felts[i].CreatedAt.Before(felts[j].CreatedAt)
	})
}

func formatSessionExamples(felts []*felt.Felt) string {
	if len(felts) == 0 {
		return "none"
	}
	limit := len(felts)
	if limit > 3 {
		limit = 3
	}
	ids := make([]string, 0, limit)
	for _, f := range felts[:limit] {
		ids = append(ids, f.ID)
	}
	return strings.Join(ids, ", ")
}

func pluralize(count int, singular, plural string) string {
	if count == 1 {
		return singular
	}
	return plural
}

// ----------------------------------------------------------------------------
// PreToolUse gate
// ----------------------------------------------------------------------------

const preToolDenyReason = "Activate the felt skill first. You are in a felt-enabled project but haven't activated the felt skill yet. Call the Skill tool with skill: \"felt\" before proceeding with any other tools. The skill body carries the philosophy, CLI cheatsheet, and references that shape how to work — reading the SessionStart context is not the same as having the skill loaded."

type preToolInput struct {
	SessionID      string `json:"session_id"`
	ToolName       string `json:"tool_name"`
	CWD            string `json:"cwd"`
	TranscriptPath string `json:"transcript_path"`
	ToolInput      struct {
		Skill string `json:"skill"`
	} `json:"tool_input"`
}

// runPreToolHook implements the PreToolUse deny gate. See cmd/hook_test.go for
// the matrix; the rules are:
//
//   - outside felt-enabled projects (no .felt at cwd): pass.
//   - Skill tool activating felt: mark flag, pass.
//   - Skill tool activating something else: pass (don't mark).
//   - Codex (transcript_path not under ~/.claude/projects/, or empty): mark, pass.
//   - flag already set: pass.
//   - otherwise: emit deny envelope.
func runPreToolHook(stdin *os.File, stdout *os.File) error {
	var input preToolInput
	if err := json.NewDecoder(stdin).Decode(&input); err != nil {
		// Can't parse input: silent pass. Better to lose the gate than block.
		return nil
	}

	if input.CWD == "" {
		return nil
	}
	if _, err := os.Stat(filepath.Join(input.CWD, ".felt")); os.IsNotExist(err) {
		return nil
	}

	flagPath := filepath.Join(os.TempDir(), "felt-reminded-"+input.SessionID)

	// Skill tool: open the gate only on felt activation specifically. Without
	// this asymmetry an agent could bypass felt by activating a sibling skill
	// (e.g. shuttle) as its first move.
	if input.ToolName == "Skill" {
		s := input.ToolInput.Skill
		if s == "felt" || s == "felt:felt" || strings.HasPrefix(s, "felt@") {
			_ = os.WriteFile(flagPath, nil, 0644)
		}
		return nil
	}

	// Codex sessions: no Skill tool to activate, and the deny would deadlock
	// the loop. Detect by transcript_path NOT being under ~/.claude/projects/.
	home, _ := os.UserHomeDir()
	claudePrefix := filepath.Join(home, ".claude", "projects") + string(filepath.Separator)
	if input.TranscriptPath == "" || !strings.HasPrefix(input.TranscriptPath, claudePrefix) {
		_ = os.WriteFile(flagPath, nil, 0644)
		return nil
	}

	if _, err := os.Stat(flagPath); err == nil {
		return nil
	}

	type denyInner struct {
		HookEventName            string `json:"hookEventName"`
		PermissionDecision       string `json:"permissionDecision"`
		PermissionDecisionReason string `json:"permissionDecisionReason"`
	}
	type denyEnvelope struct {
		HookSpecificOutput denyInner `json:"hookSpecificOutput"`
	}
	envelope := denyEnvelope{HookSpecificOutput: denyInner{
		HookEventName:            "PreToolUse",
		PermissionDecision:       "deny",
		PermissionDecisionReason: preToolDenyReason,
	}}
	return encodeHookJSON(stdout, envelope)
}
