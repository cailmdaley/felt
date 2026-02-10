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
- When in doubt, prefer felt—persistence you don't need is better than lost context
`
}

func formatSessionOutput(felts []*felt.Felt, g *felt.Graph) string {
	var sb strings.Builder

	sb.WriteString("# Felt Workflow Context\n\n")

	// Collect active and closed fibers
	var active []*felt.Felt
	var closed []*felt.Felt
	for _, f := range felts {
		if f.IsActive() {
			active = append(active, f)
		} else if f.IsClosed() {
			closed = append(closed, f)
		}
	}

	// Sort active by priority, then creation time
	sort.Slice(active, func(i, j int) bool {
		if active[i].Priority != active[j].Priority {
			return active[i].Priority < active[j].Priority
		}
		return active[i].CreatedAt.Before(active[j].CreatedAt)
	})

	// Sort closed by closed time (most recent first)
	sort.Slice(closed, func(i, j int) bool {
		if closed[i].ClosedAt == nil {
			return false
		}
		if closed[j].ClosedAt == nil {
			return true
		}
		return closed[i].ClosedAt.After(*closed[j].ClosedAt)
	})

	// Take only the 5 most recently closed
	if len(closed) > 5 {
		closed = closed[:5]
	}

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

	// Recently closed fibers for context
	if len(closed) > 0 {
		sb.WriteString("## Recently Closed\n\n")
		for _, f := range closed {
			sb.WriteString(formatClosedEntry(f))
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
	sb.WriteString("- **Leave breadcrumbs** — file fibers for decisions, questions, observations; use `felt on` to track active work\n")
	sb.WriteString("- When in doubt, prefer felt—persistence you don't need is better than lost context\n")

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

// formatClosedEntry formats a closed fiber for the recently closed section.
// Same two-line format as formatFiberEntry but includes outcome.
func formatClosedEntry(f *felt.Felt) string {
	// Line 1: status + ID
	line1 := fmt.Sprintf("● %s\n", f.ID)

	// Line 2: indented title with tags
	var meta []string
	if len(f.Tags) > 0 {
		meta = append(meta, strings.Join(f.Tags, ", "))
	}

	metaStr := ""
	if len(meta) > 0 {
		metaStr = fmt.Sprintf(" (%s)", strings.Join(meta, ", "))
	}

	line2 := fmt.Sprintf("    %s%s\n", f.Title, metaStr)

	// Line 3: outcome (indented, truncated)
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
felt "title"                    # create fiber (no status by default)
felt add "title" -s open        # -s: opt into tracking (open, active, closed)
felt add "title" -o "answer"    # -o: set outcome
felt add "title" -a <dep-id>    # -a: depends on (after)
felt on <id>                    # start working (enters tracking)
felt off <id> -o "outcome"      # set outcome (closes if tracked)
felt comment <id> "note"        # add comment
felt ls                         # tracked fibers (open/active)
felt ls --all                   # all fibers including untracked
felt show <id>                  # full details
felt ready                      # fibers with all deps closed
felt find "query"               # search title/body/outcome
felt link <id> <dep-id>         # add dependency
felt upstream/downstream <id>   # see connections
felt edit <id> --title "new"    # replace metadata (title, due, outcome)
` + "```" + `
Statuses: · untracked, ○ open, ◐ active, ● closed
To patch body text (not replace), edit .felt/<id>.md directly.

`
}

