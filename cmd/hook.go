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

var hookCmd = &cobra.Command{
	Use:   "hook",
	Short: "Commands for integration hooks",
	Long:  `Commands for integrating felt with external tools like Claude Code.`,
}

var hookSessionCmd = &cobra.Command{
	Use:   "session",
	Short: "Output workflow context for session start",
	Long: `Outputs felt workflow context for use in Claude Code SessionStart hooks.

Prints active and recently touched fibers in a format suitable for AI context.`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := resolveProjectRoot()
		if err != nil {
			// Not in a felt repository - output minimal context
			fmt.Print(minimalOutput())
			return nil
		}

		storage := felt.NewStorage(root)
		felts, err := storage.ListMetadataWithModTime()
		if err != nil {
			return err
		}

		output := formatSessionOutput(felts)
		fmt.Print(output)
		return nil
	},
}

var hookRemindCmd = &cobra.Command{
	Use:   "remind",
	Short: "One-shot reminder to activate /felt skill",
	Long: `PreToolUse hook that gates tool use until /felt skill is activated.

Denies all non-Skill tool calls until the Skill tool has been called (which sets a
per-session flag file in /tmp). After that, all tools are allowed. Only active in
directories containing a .felt/ directory.

Designed for use as a PreToolUse hook in Claude Code settings.`,
	Args:         cobra.NoArgs,
	SilenceUsage: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		return runRemindHook()
	},
}

func init() {
	rootCmd.AddCommand(hookCmd)
	hookCmd.AddCommand(hookSessionCmd)
	hookCmd.AddCommand(hookRemindCmd)
}

func feltDescription() string {
	return "felt is a markdown fiber tracker. Fibers are concerns — tasks, decisions, findings — stored in `.felt/` as directory-contained markdown with YAML frontmatter, wikilinks in the body, and optional ASTRA structure.\n\n"
}

func minimalOutput() string {
	return "# Felt Workflow Context\n\n" + feltDescription() +
		"*No felt repository in current directory.*\n\n" +
		cliReference() + coreRules()
}

func formatSessionOutput(felts []*felt.Felt) string {
	var sb strings.Builder

	sb.WriteString("# Felt Workflow Context\n\n")
	sb.WriteString(feltDescription())

	// Collect active fibers
	var active []*felt.Felt
	for _, f := range felts {
		if f.IsActive() {
			active = append(active, f)
		}
	}

	// Sort active by creation time
	sort.Slice(active, func(i, j int) bool {
		return active[i].CreatedAt.Before(active[j].CreatedAt)
	})

	if len(active) > 0 {
		sb.WriteString("## Active Fibers\n\n")
		for _, f := range active {
			sb.WriteString(formatFeltTwoLine(f))
		}
		sb.WriteString("\n")
	}

	if len(active) == 0 {
		sb.WriteString("*No active fibers.*\n\n")
	}

	// Recently touched: 5 most recently modified, excluding active.
	shown := make(map[string]bool, len(active))
	for _, f := range active {
		shown[f.ID] = true
	}

	var recent []*felt.Felt
	for _, f := range felts {
		if !shown[f.ID] {
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
			sb.WriteString(formatRecentEntry(f))
		}
		sb.WriteString("\n")
	}

	sb.WriteString(cliReference())
	sb.WriteString(coreRules())

	return sb.String()
}

// formatRecentEntry formats a recently-touched fiber for the hook.
// Shows status icon, title with tags, and outcome if present.
func formatRecentEntry(f *felt.Felt) string {
	icon := felt.StatusIcon(f.Status)

	line1 := fmt.Sprintf("%s %s\n", icon, f.ID)

	tagStr := ""
	if len(f.Tags) > 0 {
		tagStr = fmt.Sprintf(" (%s)", strings.Join(f.Tags, ", "))
	}
	line2 := fmt.Sprintf("    %s%s\n", f.DisplayName(), tagStr)

	line3 := ""
	if f.Outcome != "" {
		outcome := f.Outcome
		if len(outcome) > 100 {
			outcome = outcome[:100] + "..."
		}
		line3 = fmt.Sprintf("    → %s\n", outcome)
	}

	return line1 + line2 + line3
}

// cliReference returns a concise CLI reference for the session hook.
func cliReference() string {
	return `## CLI
` + "```" + `
felt init                       # initialize .felt/ + myst.yml
felt <slug> "name"              # create fiber
felt add <slug> "name" [flags]  # create with status/tags/outcome
felt edit <id> --status active  # enter tracking / mark active
felt edit <id> --status closed --outcome "outcome"
felt edit <id> --name "new name"
felt edit <id> --tag foo --untag bar
felt edit <id> --body "text"    # full body replacement (overwrite)
felt show <id>                  # full details
felt show <id> -d summary       # metadata + lede paragraph
felt show <id> -d compact       # metadata + outcome + ASTRA counts
felt show <id> --body           # body + start line for editing
felt ls                         # tracked fibers (open/active)
felt ls -t tapestry:            # any filter widens to all statuses
felt ls -s closed "query"       # explicit -s overrides; -e exact, -r regex
felt ls --body "query"          # FTS5 body search via .felt/index.db
felt tree                       # containment hierarchy
felt tree <id>                  # subtree for one fiber
felt check                      # lint ASTRA/formalization issues
felt nest <child> <parent>      # move into parent subtree
felt unnest <child>             # promote back to top level
felt migrate [--dry-run]        # normalize legacy layout/title/anchors
felt export --format astra      # write astra.yaml from ASTRA frontmatter
Also: hook session, rm, setup, update
` + "```" + `
Statuses: · untracked, ○ open, ◐ active, ● closed
Detail: title < compact < summary < full (default). Summary shows the **lede** — the first paragraph of the body. Write it to stand alone. ` + "`felt show`" + ` also surfaces indexed citations from wikilinks.
To patch body text (not replace), Read then Edit the fiber markdown file in .felt/<path>/<slug>.md. Nested fibers use path IDs like bao-analysis/damping-prior.

`
}

// runRemindHook gates tool use until /felt is activated.
// Denies all non-Skill tools until Skill has been called, then allows everything.
func runRemindHook() error {
	var input struct {
		SessionID string `json:"session_id"`
		ToolName  string `json:"tool_name"`
		CWD       string `json:"cwd"`
	}
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		return nil // can't parse — silent exit
	}

	// Only gate in felt-enabled projects
	cwd := input.CWD
	if cwd == "" {
		return nil
	}
	if _, err := os.Stat(filepath.Join(cwd, ".felt")); os.IsNotExist(err) {
		return nil
	}

	flagFile := filepath.Join(os.TempDir(), "felt-reminded-"+input.SessionID)

	// Skill call: set the flag (gate opens) and allow
	if input.ToolName == "Skill" {
		os.WriteFile(flagFile, nil, 0644)
		return nil
	}

	// Any other tool: check if Skill has already been called
	if _, err := os.Stat(flagFile); err == nil {
		return nil // gate is open
	}

	// Gate is closed — deny the tool call
	output := map[string]interface{}{
		"hookSpecificOutput": map[string]interface{}{
			"hookEventName":      "PreToolUse",
			"permissionDecision": "deny",
			"permissionDecisionReason": "Activate /felt skill first. You are in a felt-enabled project " +
				"but haven't activated the felt skill yet. Call the Skill tool with " +
				"skill: \"felt\" before proceeding with any other tools.",
		},
	}
	return json.NewEncoder(os.Stdout).Encode(output)
}

// coreRules returns the shared core rules.
func coreRules() string {
	return `## Core Rules
- **File as you go.** Decisions, questions, detours, bugs you can't chase now — if it might matter, it's a fiber. A missing link in the causal chain costs an investigation; a fiber costs nothing.
- **Outcomes teach.** The outcome is a one-sentence conclusion — what was learned, decided, or produced. It appears in ` + "`felt ls`" + ` and ` + "`-d compact`" + `, so write it to stand alone. The body carries the full argument.
- **Formalize while working.** Accrete ASTRA structure as it becomes real: ` + "`decisions:`" + ` when alternatives are rejected, ` + "`inputs:`" + `/` + "`outputs:`" + ` while jobs run, ` + "`insights:`" + ` when claims have evidence.
- **Compose upward.** When closing a fiber, ask: does this lesson belong in a doc fiber or the root fiber? Consolidate breadcrumbs into authoritative fibers. Update the root fiber when project context changes.
- **CLI for metadata, Read+Edit for content.** ` + "`felt edit`" + ` for status/tags/outcome. Read then Edit ` + "`.felt/<slug>/<slug>.md`" + ` for body text, wikilinks, and ASTRA frontmatter.
- **Names are concise labels.** Body and outcome carry full content.
`
}
