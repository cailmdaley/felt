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
	Short: "Output full context for session recovery",
	Long: `Outputs comprehensive felt context for recovering context after
compaction, clear, or starting a new session.

Shows active fibers with their full bodies, ready fibers with descriptions,
and recently closed fibers for context.`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		root, err := felt.FindProjectRoot()
		if err != nil {
			fmt.Println("*No felt repository in current directory.*")
			return nil
		}

		storage := felt.NewStorage(root)
		felts, err := storage.List()
		if err != nil {
			return err
		}

		g := felt.BuildGraph(felts)
		output := formatPrimeOutput(felts, g)
		fmt.Print(output)
		return nil
	},
}

func init() {
	rootCmd.AddCommand(hookCmd)
	rootCmd.AddCommand(primeCmd)
	hookCmd.AddCommand(hookSessionCmd)
}

func minimalOutput() string {
	return `# Felt Workflow Context

> **Context Recovery**: Run ` + "`felt prime`" + ` after compaction, clear, or new session

*No felt repository in current directory.*

## Core Rules
- Track **work** that spans sessions, has dependencies, or emerges during work
- Track **decisions** — what was decided, why, and how decisions depend on each other
- Closing reason (` + "`-r`" + `) is the documentation: capture the outcome, the reasoning, what was learned
- TodoWrite is fine for simple single-session linear tasks
- When in doubt, prefer felt—persistence you don't need is better than lost context
`
}

func formatSessionOutput(felts []*felt.Felt, g *felt.Graph) string {
	var sb strings.Builder

	sb.WriteString("# Felt Workflow Context\n\n")
	sb.WriteString("> **Context Recovery**: Run `felt prime` after compaction, clear, or new session\n\n")

	// Active fibers
	var active []*felt.Felt
	for _, f := range felts {
		if f.IsActive() {
			active = append(active, f)
		}
	}

	// Sort by priority, then creation time
	sort.Slice(active, func(i, j int) bool {
		if active[i].Priority != active[j].Priority {
			return active[i].Priority < active[j].Priority
		}
		return active[i].CreatedAt.Before(active[j].CreatedAt)
	})

	if len(active) > 0 {
		sb.WriteString("## Active Fibers\n\n")
		for _, f := range active {
			sb.WriteString(formatFiberEntry("◐", f))
		}
		sb.WriteString("\n")
	}

	// Ready fibers (open with all deps closed)
	ready := g.Ready()
	if len(ready) > 0 {
		sb.WriteString("## Ready Fibers (unblocked)\n\n")
		for _, f := range ready {
			sb.WriteString(formatFiberEntry("○", f))
		}
		sb.WriteString("\n")
	}

	// If nothing active or ready, note that
	if len(active) == 0 && len(ready) == 0 {
		sb.WriteString("*No active or ready fibers.*\n\n")
	}

	// Core rules
	sb.WriteString("## Core Rules\n")
	sb.WriteString("- Track **work** that spans sessions, has dependencies, or emerges during work\n")
	sb.WriteString("- Track **decisions** — what was decided, why, and how decisions depend on each other\n")
	sb.WriteString("- Closing reason (`-r`) is the documentation: capture the outcome, the reasoning, what was learned\n")
	sb.WriteString("- TodoWrite is fine for simple single-session linear tasks\n")
	sb.WriteString("- When in doubt, prefer felt—persistence you don't need is better than lost context\n")

	return sb.String()
}

// formatFiberEntry formats a single fiber for hook output.
// Shows kind label when not the default "task" kind.
func formatFiberEntry(icon string, f *felt.Felt) string {
	kindStr := ""
	if f.Kind != felt.DefaultKind {
		kindStr = fmt.Sprintf(" [%s]", f.Kind)
	}
	return fmt.Sprintf("%s %s%s  %s\n", icon, f.ID, kindStr, f.Title)
}

func formatPrimeOutput(felts []*felt.Felt, g *felt.Graph) string {
	var sb strings.Builder

	sb.WriteString("# Felt Context Recovery\n\n")

	// Collect active, ready, and recently closed fibers
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
		// Handle nil ClosedAt (shouldn't happen but be safe)
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

	// Active fibers with full details
	if len(active) > 0 {
		sb.WriteString("## Active Fibers\n\n")
		for _, f := range active {
			sb.WriteString(formatFiberDetail(f))
		}
	}

	// Ready fibers with descriptions
	if len(ready) > 0 {
		sb.WriteString("## Ready Fibers\n\n")
		for _, f := range ready {
			sb.WriteString(formatFiberDetail(f))
		}
	}

	// If nothing active or ready
	if len(active) == 0 && len(ready) == 0 {
		sb.WriteString("*No active or ready fibers.*\n\n")
	}

	// Recently closed fibers for context
	if len(closed) > 0 {
		sb.WriteString("## Recently Closed\n\n")
		for _, f := range closed {
			sb.WriteString(formatClosedFiberSummary(f))
		}
	}

	return sb.String()
}

// formatFiberDetail formats a fiber with full details for prime output.
func formatFiberDetail(f *felt.Felt) string {
	var sb strings.Builder

	// Header line
	icon := "○"
	if f.IsActive() {
		icon = "◐"
	}
	kindStr := ""
	if f.Kind != felt.DefaultKind {
		kindStr = fmt.Sprintf(" [%s]", f.Kind)
	}
	sb.WriteString(fmt.Sprintf("### %s %s%s\n", icon, f.Title, kindStr))
	sb.WriteString(fmt.Sprintf("ID: `%s`\n", f.ID))

	// Dependencies
	if len(f.DependsOn) > 0 {
		sb.WriteString(fmt.Sprintf("Depends on: %s\n", strings.Join(f.DependsOn, ", ")))
	}

	// Body (truncated if very long)
	if f.Body != "" {
		body := f.Body
		if len(body) > 500 {
			body = body[:500] + "..."
		}
		sb.WriteString(fmt.Sprintf("\n%s\n", body))
	}

	sb.WriteString("\n")
	return sb.String()
}

// formatClosedFiberSummary formats a closed fiber with its close reason.
func formatClosedFiberSummary(f *felt.Felt) string {
	var sb strings.Builder

	kindStr := ""
	if f.Kind != felt.DefaultKind {
		kindStr = fmt.Sprintf(" [%s]", f.Kind)
	}
	sb.WriteString(fmt.Sprintf("### ● %s%s\n", f.Title, kindStr))
	sb.WriteString(fmt.Sprintf("ID: `%s`\n", f.ID))

	if f.CloseReason != "" {
		reason := f.CloseReason
		if len(reason) > 200 {
			reason = reason[:200] + "..."
		}
		sb.WriteString(fmt.Sprintf("Closed: %s\n", reason))
	}

	sb.WriteString("\n")
	return sb.String()
}
