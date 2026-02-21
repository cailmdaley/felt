package cmd

import (
	"fmt"
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

Prints active fibers (currently being worked on) and ready fibers
(open with all dependencies closed) in a format suitable for AI context.`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := felt.FindProjectRoot()
		if err != nil {
			// Not in a felt repository - output minimal context
			fmt.Print(minimalOutput())
			return nil
		}

		storage := felt.NewStorage(root)
		felts, err := storage.List()
		if err != nil {
			return err
		}

		g := felt.BuildGraph(felts)
		output := formatSessionOutput(felts, g)
		fmt.Print(output)
		return nil
	},
}

var primeCmd = &cobra.Command{
	Use:   "prime",
	Short: "Output workflow context (alias for hook session)",
	Long:  `Outputs felt workflow context. Alias for 'felt hook session'.`,
	Args:  cobra.NoArgs,
	RunE:  hookSessionCmd.RunE,
}

func init() {
	rootCmd.AddCommand(hookCmd)
	rootCmd.AddCommand(primeCmd)
	hookCmd.AddCommand(hookSessionCmd)
}

func minimalOutput() string {
	return `# Felt Workflow Context

*No felt repository in current directory.*

` + cliReference() + `## Core Rules
- Track **work** that spans sessions, has dependencies, or emerges during work
- Track **decisions** — what was decided, why, and how decisions depend on each other
- Outcome (` + "`-o`" + `) is the documentation: capture the conclusion, the reasoning, what was learned
- **Leave a wake** — file as you go; the DAG forms after your path
- **Titles are DAG node labels: 2-3 words.** The body and outcome carry full content.
`
}

func formatSessionOutput(felts []*felt.Felt, g *felt.Graph) string {
	var sb strings.Builder

	sb.WriteString("# Felt Workflow Context\n\n")

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

	ready := g.Ready()

	if len(active) > 0 {
		sb.WriteString("## Active Fibers\n\n")
		for _, f := range active {
			sb.WriteString(formatFiberEntry("◐", f))
		}
		sb.WriteString("\n")
	}

	if len(ready) > 0 {
		sb.WriteString("## Ready Fibers\n\n")
		for _, f := range ready {
			sb.WriteString(formatFiberEntry("○", f))
		}
		sb.WriteString("\n")
	}

	// If nothing active or ready, note that
	if len(active) == 0 && len(ready) == 0 {
		sb.WriteString("*No active or ready fibers.*\n\n")
	}

	// Recently touched: 5 most recently modified, excluding active/ready
	shown := make(map[string]bool, len(active)+len(ready))
	for _, f := range active {
		shown[f.ID] = true
	}
	for _, f := range ready {
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

	// CLI Reference
	sb.WriteString(cliReference())

	// Core rules
	sb.WriteString("## Core Rules\n")
	sb.WriteString("- Track **work** that spans sessions, has dependencies, or emerges during work\n")
	sb.WriteString("- Track **decisions** — what was decided, why, and how decisions depend on each other\n")
	sb.WriteString("- Outcome (`-o`) is the documentation: capture the conclusion, the reasoning, what was learned\n")
	sb.WriteString("- **Leave a wake** — file as you go; the DAG forms after your path\n")
	sb.WriteString("- **Titles are DAG node labels: 2-3 words.** The body and outcome carry full content.\n")

	return sb.String()
}

// formatFiberEntry formats a single fiber for hook output.
// Two-line format: icon + ID, then indented title with metadata.
func formatFiberEntry(icon string, f *felt.Felt) string {
	// Line 1: status + ID
	line1 := fmt.Sprintf("%s %s\n", icon, f.ID)

	// Line 2: indented title with metadata (tags, deps)
	var meta []string
	if len(f.Tags) > 0 {
		meta = append(meta, strings.Join(f.Tags, ", "))
	}
	if len(f.DependsOn) > 0 {
		meta = append(meta, fmt.Sprintf("%d deps", len(f.DependsOn)))
	}

	metaStr := ""
	if len(meta) > 0 {
		metaStr = fmt.Sprintf(" (%s)", strings.Join(meta, ", "))
	}

	line2 := fmt.Sprintf("    %s%s\n", f.Title, metaStr)

	return line1 + line2
}

// formatRecentEntry formats a recently-touched fiber for the hook.
// Shows status icon, title with tags, and outcome if present.
func formatRecentEntry(f *felt.Felt) string {
	icon := statusIcon(f.Status)

	line1 := fmt.Sprintf("%s %s\n", icon, f.ID)

	tagStr := ""
	if len(f.Tags) > 0 {
		tagStr = fmt.Sprintf(" (%s)", strings.Join(f.Tags, ", "))
	}
	line2 := fmt.Sprintf("    %s%s\n", f.Title, tagStr)

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
felt "title"                    # create fiber
felt add "title" -s open -t tag -a <dep-id> -o "outcome"
felt edit <id> -s active        # enter tracking / mark active
felt edit <id> -s closed -o "outcome"  # close with outcome
felt comment <id> "note"        # add comment
felt show <id>                  # full details (-d: title, compact, summary)
felt ls                         # tracked fibers (open/active)
felt ls -t tapestry:            # any filter widens to all statuses
felt ls -s closed "query"       # explicit -s overrides; -e exact, -r regex
Also: link, unlink, tag, untag, upstream, downstream, tree, ready, rm
` + "```" + `
Statuses: · untracked, ○ open, ◐ active, ● closed
To patch body text (not replace), edit .felt/<id>.md directly.

`
}

