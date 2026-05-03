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
	Short: "Per-tool felt-session marker (currently a no-op pass-through)",
	Long: `PreToolUse hook for felt-enabled projects. Reads the tool-call payload, marks
a per-session flag file under TMPDIR, and exits silently — no permission decisions
are emitted. SessionStart already delivers the felt context the agent needs, so
the historical first-tool deny gate is off; the flag-write is preserved so a
gate can be re-introduced as a one-line addition without revisiting the hook
shape.

Designed to register as a PreToolUse hook in both Claude Code and Codex.`,
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
	return "felt captures the thinking as you work, across sessions. " +
		"A fiber is any concern (decision, finding, question, detour) worth naming because it might matter later; " +
		"filing costs nothing, forgetting costs an investigation or a hallucination. " +
		"Fibers start as a name and accrete: body, outcome, tags, and optional structured frontmatter (decisions, inputs, insights) as the work crystallizes. " +
		"Do this incrementally: after you respond, while the user reads, file what just came into focus. " +
		"Don't ask permission. " +
		"Let the user's opinions and corrections guide the fibers; you are following the understanding as it evolves, reversals included.\n\n"
}

func minimalOutput() string {
	return "# Felt Workflow Context\n\n" + feltDescription() +
		"*No felt repository in current directory. Start one with `felt init`.*\n\n" +
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
// Shows status icon, name with tags, and outcome if present.
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
Something came into focus. Start:
    felt add <slug> "name" -t tag -o "one-line outcome"

Understanding crystallized. Accrete:
    felt edit <id> --status active
    felt edit <id> --tag X
    felt edit <id> --decision cov --label "Covariance" --option 'glass:GLASS mocks'
    felt edit <id> --input 'catalog:data:build-mocks.galaxy-catalog'    # id:type:source.output
    felt edit <id> --insight 'stability:Posterior is stable under jackknife'
    Read then Edit .felt/<path>/<slug>.md                               # body, wikilinks, deeper frontmatter

Search and read:
    felt ls                                              # tracked (open and active)
    felt ls "query" [-t tag] [-s closed]                 # any filter widens to all statuses
    felt ls --body "query"                               # FTS5 body search
    felt show <id>                                       # full
    felt show <id> -d summary | -d compact               # metadata + lede | + frontmatter counts
    felt show <id> --body                                # body with start line
    felt show <id> --decisions|--inputs|--insights       # targeted frontmatter slices

A thread resolved. Close:
    felt edit <id> --status closed --outcome "what was learned"

History (per-fiber append-only event log):
    felt history <id>                                    # editorial chain (newest first)
    felt history <id> --last 1                           # what the previous session left
    felt history <id> --mechanical                       # + add/edit/rm/external_edit
    felt history append <id> --summary "..."             # log session continuity

Maintain:
    felt check                                           # broken refs, frontmatter issues
    felt migrate [--dry-run]                             # normalize legacy layout
` + "```" + `
Statuses: · untracked, ○ open, ◐ active, ● closed
Detail: name < compact < summary < full. Summary shows the lede (first paragraph of the body; write it to stand alone).
Relationships: directory containment, ` + "`[[wikilinks]]`" + ` in bodies, ` + "`inputs.from`" + ` for data flow. Nested IDs use paths (bao-analysis/damping-prior).

**Outcomes longer than a sentence:** edit ` + "`.felt/<path>/<slug>.md`" + ` directly using a ` + "`|-`" + ` block scalar (` + "`outcome: |-`" + `). ` + "`felt edit -o \"…\"`" + ` shell-escapes quotes and mangles multiline content; block scalar takes content literally so paragraphs, lists, and image embeds round-trip cleanly.

`
}

// runRemindHook is the PreToolUse handler. Currently a pass-through: it reads
// the payload, marks a per-session flag file (so a deny gate can be reintroduced
// later without reshaping the hook), and exits silently. SessionStart delivers
// felt context, which proved sufficient on its own; the first-tool deny was
// retired as needless friction.
func runRemindHook() error {
	var input struct {
		SessionID string `json:"session_id"`
		CWD       string `json:"cwd"`
	}
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		return nil // can't parse — silent exit
	}

	// Only mark in felt-enabled projects
	cwd := input.CWD
	if cwd == "" {
		return nil
	}
	if _, err := os.Stat(filepath.Join(cwd, ".felt")); os.IsNotExist(err) {
		return nil
	}

	flagFile := filepath.Join(os.TempDir(), "felt-reminded-"+input.SessionID)
	_ = os.WriteFile(flagFile, nil, 0644)
	return nil
}

// coreRules returns the shared core rules.
func coreRules() string {
	return `## Core Rules
- **Outcomes teach.** One-sentence conclusions that stand alone: they appear in ` + "`felt ls`" + ` and ` + "`-d compact`" + `.
- **Use the right relationship surface.** Nest for containment, ` + "`[[wikilinks]]`" + ` for narrative, ` + "`inputs.from`" + ` for computational provenance only.
- **Compose upward.** When closing, ask whether the lesson belongs in a doc fiber or the root fiber; consolidate breadcrumbs.
- **Names are concise labels.** Body and outcome carry the content.
- **Activate ` + "`/felt`" + ` first.** Before any tool or action, regardless of what the user asked for.
`
}
