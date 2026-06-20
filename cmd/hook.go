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

// encodeHookJSON writes indented JSON without HTML-escaping `<>&` (Go's encoder
// escapes them by default). The wire is semantically equivalent either way, but
// the unescaped form reads more cleanly in logs where fiber bodies contain
// angle brackets. Output is pinned by cmd/hook_test.go — change it deliberately.
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

var hookPostToolCmd = &cobra.Command{
	Use:   "posttool",
	Short: "PostToolUse: stamp updated-at when an agent edits a fiber file directly",
	Long: `Reads the PostToolUse payload from stdin. When the tool was an Edit/Write/
MultiEdit on a markdown file inside a felt store, stamps the owning fiber's
git-durable recency anchor (frontmatter updated-at).

This is what makes direct Edit-tool body edits count toward recency without
felt's own read commands ever writing files: the harness fires this hook at the
moment of the edit, so the stamping happens in the agent layer, not in felt's
Sync. Edits felt makes itself (felt add/edit) already stamp inline. Silent
pass-through for non-edit tools, non-felt files, and any error.`,
	Args:         cobra.NoArgs,
	SilenceUsage: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		return runPostToolHook(os.Stdin)
	},
}

func init() {
	rootCmd.AddCommand(sessionCmd)
	rootCmd.AddCommand(hookCmd)
	hookCmd.AddCommand(hookSessionCmd)
	hookCmd.AddCommand(hookPreToolCmd)
	hookCmd.AddCommand(hookPostToolCmd)
}

// ----------------------------------------------------------------------------
// SessionStart context
// ----------------------------------------------------------------------------

const sessionDirective = "**Activate the `felt` skill before any tool or action — every session, even when the user's request seems unrelated to felt.** The skill body carries the practice (philosophy, CLI, references). Reading this context is not the same as having the skill loaded."

const sessionNoRepoNote = "*No felt repository in current directory. Start one with `felt init` when this conversation produces thinking worth keeping.*"

const sessionNoTrackedNote = "*No active or open fibers.*"

const (
	// sessionActiveLimit is the Attention threshold for "active set is broad"
	// — it gates the advisory note, not the display. Distinct from the display
	// cap below.
	sessionActiveLimit = 3
	// sessionSectionLimit caps both recency sections: five in-flight fibers
	// (active or open), then five fibers in every remaining status.
	sessionSectionLimit  = 5
	sessionOpenLimit     = 20
	sessionTopLevelLimit = 20
	sessionStaleAge      = 30 * 24 * time.Hour
)

// buildSessionContext renders the markdown additionalContext text. Output is
// pinned by cmd/hook_test.go — change it deliberately; a wording or layout
// change shows up as a test diff.
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

	// Recency signal is the git-durable frontmatter anchor — updated-at when
	// present, else created-at (RecencyAnchor) — never file mtime and never the
	// history index. felt is git-synced across machines: mtime is flattened by
	// every clone/checkout/reorg, and the history event log lives in a per-store
	// index.db that is NOT git-synced, so two machines disagree on it. updated-at
	// rides in the frontmatter, so every machine reads the same recency. It is
	// stamped on every real content write — felt add/edit and the PostToolUse
	// hook on direct Edit-tool edits — and deliberately preserved (not bumped)
	// across moves/renames, which is what keeps it reorg-immune.
	recency := func(f *felt.Felt) time.Time { return f.RecencyAnchor() }
	byRecencyDesc := func(fs []*felt.Felt) {
		sort.SliceStable(fs, func(i, j int) bool {
			return recency(fs[i]).After(recency(fs[j]))
		})
	}

	// Partition once so every fiber appears in exactly one section. Active and
	// open fibers are the in-flight working set; closed and untracked fibers
	// form the recent context tail.
	var inFlight, recent []*felt.Felt
	for _, f := range felts {
		if f.IsActive() || f.IsOpen() {
			inFlight = append(inFlight, f)
		} else {
			recent = append(recent, f)
		}
	}
	byRecencyDesc(inFlight)
	byRecencyDesc(recent)
	if len(inFlight) > sessionSectionLimit {
		inFlight = inFlight[:sessionSectionLimit]
	}
	if len(recent) > sessionSectionLimit {
		recent = recent[:sessionSectionLimit]
	}

	if len(inFlight) > 0 {
		sb.WriteString("## Active / Open\n\n")
		for _, f := range inFlight {
			sb.WriteString(formatHookEntry(f, recency(f), false))
		}
		sb.WriteString("\n")
	} else {
		sb.WriteString(sessionNoTrackedNote)
		sb.WriteString("\n\n")
	}

	if len(recent) > 0 {
		sb.WriteString("## Recently Touched\n\n")
		for _, f := range recent {
			sb.WriteString(formatHookEntry(f, recency(f), true))
		}
		sb.WriteString("\n")
	}

	if attention := buildSessionAttention(felts, time.Now()); attention != "" {
		sb.WriteString(attention)
		sb.WriteString("\n")
	}

	return sb.String()
}

// formatHookEntry renders one fiber for the SessionStart context. The head line
// is icon + recency timestamp + id, so the visible label carries the same
// last-touched time the sections are ranked by. Active entries get the two-line
// form (head, then indented name + tags); recently-touched entries add a third
// line with a truncated outcome.
func formatHookEntry(f *felt.Felt, recency time.Time, withOutcome bool) string {
	icon := felt.StatusIcon(f.Status)
	line1 := fmt.Sprintf("%s %s\n", icon, hookEntryHead(f, recency))

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

// hookEntryHead renders the "<timestamp> — <id>" label for a session entry,
// using the same local "2006-01-02 15:04" rendering as `felt history` and the
// `felt show` Recent line so the timestamp reads consistently across surfaces.
// Falls back to a bare id when the fiber has no recency anchor at all (both
// updated-at and created-at unset).
func hookEntryHead(f *felt.Felt, recency time.Time) string {
	if recency.IsZero() {
		return f.ID
	}
	return recency.Local().Format("2006-01-02 15:04") + " — " + f.ID
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

// ----------------------------------------------------------------------------
// PostToolUse: recency stamping for direct edits
// ----------------------------------------------------------------------------

type postToolInput struct {
	ToolName  string `json:"tool_name"`
	CWD       string `json:"cwd"`
	ToolInput struct {
		FilePath string `json:"file_path"`
	} `json:"tool_input"`
}

// postToolEditTools are the file-mutating tools whose edits should advance a
// fiber's recency. The plugin's hooks.json matcher already narrows to these,
// but we re-check so the binary is correct even under a harness (e.g. Codex)
// that fires PostToolUse without honoring the matcher.
var postToolEditTools = map[string]struct{}{
	"Edit": {}, "Write": {}, "MultiEdit": {},
}

// runPostToolHook stamps the durable recency anchor (updated-at) on the fiber
// whose file an agent just edited directly. Every path is a silent pass: a
// PostToolUse hook must never fail the tool call, and losing one stamp is
// cheaper than blocking. felt's own Sync still catches the edit warm in the
// index; this only adds the cold-clone-durable frontmatter stamp.
func runPostToolHook(stdin *os.File) error {
	var input postToolInput
	if err := json.NewDecoder(stdin).Decode(&input); err != nil {
		return nil
	}
	if _, ok := postToolEditTools[input.ToolName]; !ok {
		return nil
	}
	fp := strings.TrimSpace(input.ToolInput.FilePath)
	if fp == "" {
		return nil
	}
	if !filepath.IsAbs(fp) && input.CWD != "" {
		fp = filepath.Join(input.CWD, fp)
	}
	root, id, ok := fiberFromEditedPath(fp)
	if !ok {
		return nil
	}

	storage := felt.NewStorage(root)
	f, err := storage.Read(id)
	if err != nil {
		// Path looked fiber-shaped but isn't a real fiber (companion file in a
		// non-fiber dir, half-written file, etc.) — leave it alone.
		return nil
	}
	f.Touch(time.Now())
	if err := storage.Write(f); err != nil {
		return nil
	}
	// Record the edit with the post-stamp bytes so the hash matches on disk:
	// felt's next Sync sees no further change and won't log a duplicate
	// external_edit. Best-effort, like every other recordMechanical call.
	if data, err := os.ReadFile(storage.Path(f.ID)); err == nil {
		recordMechanical(storage, f.ID, felt.EventEdit, nil, data)
	}
	return nil
}

// fiberFromEditedPath maps an edited file path to the felt store root and the
// fiber id that owns it, or ok=false when the path is not inside a fiber.
// Accepts both the fiber's own `<slug>.md` and any companion file in a fiber
// directory (report.html, plots) — editing either is work on the fiber. The
// store boundary is the nearest enclosing `.felt/`; the owning fiber is
// confirmed by the presence of its `<slug>.md`.
func fiberFromEditedPath(absPath string) (root, id string, ok bool) {
	marker := string(filepath.Separator) + ".felt" + string(filepath.Separator)
	idx := strings.LastIndex(absPath, marker)
	if idx < 0 {
		return "", "", false
	}
	root = absPath[:idx]
	rel := absPath[idx+len(marker):]
	dir := filepath.Dir(rel)
	if dir == "." {
		// A bare `.felt/<slug>.md` — the project's entry-point fiber.
		base := filepath.Base(rel)
		if !strings.HasSuffix(base, ".md") {
			return "", "", false
		}
		return root, strings.TrimSuffix(base, ".md"), true
	}
	// Directory-contained fiber: id is the directory path, valid only if the
	// directory carries its `<slug>.md`.
	slug := filepath.Base(dir)
	if _, err := os.Stat(filepath.Join(root, ".felt", dir, slug+".md")); err != nil {
		return "", "", false
	}
	return root, dir, true
}
