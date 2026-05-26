package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

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
	felts, err := storage.ListMetadataWithModTime()
	if err != nil {
		// Storage error: surface it in-band rather than crashing the hook.
		fmt.Fprintf(&sb, "*felt listing failed: %s*\n", err)
		return sb.String()
	}

	// Active fibers: sorted by creation time (oldest first; matches the
	// previous hook's stable order for the active set).
	var active []*felt.Felt
	for _, f := range felts {
		if f.IsActive() {
			active = append(active, f)
		}
	}
	sort.Slice(active, func(i, j int) bool {
		return active[i].CreatedAt.Before(active[j].CreatedAt)
	})

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

	// Recently touched: 5 most recent by mod time, excluding active.
	activeIDs := make(map[string]bool, len(active))
	for _, f := range active {
		activeIDs[f.ID] = true
	}
	var recent []*felt.Felt
	for _, f := range felts {
		if !activeIDs[f.ID] {
			recent = append(recent, f)
		}
	}
	sort.Slice(recent, func(i, j int) bool {
		return recent[i].ModifiedAt.After(recent[j].ModifiedAt)
	})
	if len(recent) > 5 {
		recent = recent[:5]
	}
	if len(recent) > 0 {
		sb.WriteString("## Recently Touched\n\n")
		for _, f := range recent {
			sb.WriteString(formatHookEntry(f, true))
		}
		sb.WriteString("\n")
	}

	return sb.String()
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
	// (ralph, shuttle) as its first move.
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
