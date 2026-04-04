package cmd

import (
	"fmt"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
)

// Depth levels for progressive disclosure.
const (
	DepthTitle   = "title"
	DepthCompact = "compact"
	DepthSummary = "summary"
	DepthFull    = "full"
)

// ValidDepths lists all valid depth values.
var ValidDepths = []string{DepthTitle, DepthCompact, DepthSummary, DepthFull}

// validateDepth checks if a depth value is valid.
func validateDepth(d string) error {
	for _, v := range ValidDepths {
		if d == v {
			return nil
		}
	}
	return fmt.Errorf("invalid depth %q (valid: %s)", d, strings.Join(ValidDepths, ", "))
}

// renderFelt renders a felt at the given depth level.
func renderFelt(f *felt.Felt, g *felt.Graph, depth string) string {
	switch depth {
	case DepthTitle:
		return renderTitle(f)
	case DepthCompact:
		return renderCompact(f, g)
	case DepthSummary:
		return renderSummary(f, g)
	default:
		return renderFull(f, g)
	}
}

func renderTitle(f *felt.Felt) string {
	if len(f.Tags) > 0 {
		return fmt.Sprintf("%s (%s)\n", f.Title, strings.Join(f.Tags, ", "))
	}
	return f.Title + "\n"
}

// writeHeader writes the common ID/Title/Status/Tags block shared by
// compact, summary, and full renderers.
func writeHeader(sb *strings.Builder, f *felt.Felt) {
	fmt.Fprintf(sb, "ID:       %s\n", f.ID)
	fmt.Fprintf(sb, "Title:    %s\n", f.Title)
	if f.HasStatus() {
		fmt.Fprintf(sb, "Status:   %s\n", f.Status)
	}
	if len(f.Tags) > 0 {
		fmt.Fprintf(sb, "Tags:     %s\n", strings.Join(f.Tags, ", "))
	}
}

// writeDeps writes upstream and downstream dependency lines.
// When showTitles is true, dependency titles are included for context.
func writeDeps(sb *strings.Builder, f *felt.Felt, g *felt.Graph, showTitles bool) {
	// Use graph for title lookup only when requested
	var titleGraph *felt.Graph
	if showTitles {
		titleGraph = g
	}
	if len(f.DependsOn) > 0 {
		fmt.Fprintf(sb, "Upstream: %s\n", formatDeps(titleGraph, f.DependsOn))
	}
	if g != nil {
		if downstream := g.Downstream[f.ID]; len(downstream) > 0 {
			fmt.Fprintf(sb, "Downstream: %s\n", formatDeps(titleGraph, downstream))
		}
	}
}

func renderCompact(f *felt.Felt, g *felt.Graph) string {
	var sb strings.Builder
	writeHeader(&sb, f)
	if f.Outcome != "" {
		fmt.Fprintf(&sb, "Outcome:  %s\n", f.Outcome)
	}
	writeDeps(&sb, f, g, false)
	return sb.String()
}

func renderSummary(f *felt.Felt, g *felt.Graph) string {
	var sb strings.Builder
	writeHeader(&sb, f)
	if f.Due != nil {
		fmt.Fprintf(&sb, "Due:      %s\n", f.Due.Format("2006-01-02"))
	}
	if f.Outcome != "" {
		fmt.Fprintf(&sb, "Outcome:  %s\n", f.Outcome)
	}
	writeDeps(&sb, f, g, true)
	writeASTRASkeleton(&sb, f)
	if f.Body != "" {
		lede := extractLede(f.Body)
		fmt.Fprintf(&sb, "\n%s\n", lede)
		if remaining := len(f.Body) - len(lede); remaining > 0 {
			fmt.Fprintf(&sb, "[... %d more chars]\n", remaining)
		}
	}
	return sb.String()
}

// writeASTRASkeleton writes one-line summaries of ASTRA structure.
func writeASTRASkeleton(sb *strings.Builder, f *felt.Felt) {
	// Decisions: covariance_method → glass (1 excluded)
	if len(f.Decisions) > 0 {
		var parts []string
		for id, d := range f.Decisions {
			excluded := 0
			for _, opt := range d.Options {
				if opt.Excluded {
					excluded++
				}
			}
			s := id
			if d.Default != "" {
				s += " → " + d.Default
			}
			if excluded > 0 {
				s += fmt.Sprintf(" (%d excluded)", excluded)
			}
			parts = append(parts, s)
		}
		fmt.Fprintf(sb, "Decisions: %s\n", strings.Join(parts, "; "))
	}

	// Inputs: shear_catalog (data), psf_model (← psf-modeling)
	if len(f.Inputs) > 0 {
		var parts []string
		for _, inp := range f.Inputs {
			s := inp.ID
			if inp.From != "" {
				s += " (← " + inp.From + ")"
			} else if inp.Type != "" {
				s += " (" + inp.Type + ")"
			}
			parts = append(parts, s)
		}
		fmt.Fprintf(sb, "Inputs:    %s\n", strings.Join(parts, ", "))
	}

	// Outputs: posterior (data), corner_plot (figure)
	if len(f.Outputs) > 0 {
		var parts []string
		for _, out := range f.Outputs {
			s := out.ID
			if out.Type != "" {
				s += " (" + out.Type + ")"
			}
			parts = append(parts, s)
		}
		fmt.Fprintf(sb, "Outputs:   %s\n", strings.Join(parts, ", "))
	}

	// Findings: leakage_negligible — "PSF leakage α < 0.01 for all bins"
	if len(f.Insights) > 0 {
		var parts []string
		for id, ins := range f.Insights {
			claim := ins.Claim
			if len(claim) > 60 {
				claim = claim[:57] + "..."
			}
			parts = append(parts, fmt.Sprintf("%s — \"%s\"", id, claim))
		}
		fmt.Fprintf(sb, "Findings:  %s\n", strings.Join(parts, "; "))
	}
}

func renderFull(f *felt.Felt, g *felt.Graph) string {
	var sb strings.Builder
	writeHeader(&sb, f)
	writeDeps(&sb, f, g, true)
	if f.Due != nil {
		fmt.Fprintf(&sb, "Due:      %s\n", f.Due.Format("2006-01-02"))
	}
	fmt.Fprintf(&sb, "Created:  %s\n", f.CreatedAt.Format("2006-01-02T15:04:05-07:00"))
	if f.ClosedAt != nil {
		fmt.Fprintf(&sb, "Closed:   %s\n", f.ClosedAt.Format("2006-01-02T15:04:05-07:00"))
	}
	if f.Outcome != "" {
		fmt.Fprintf(&sb, "Outcome:  %s\n", f.Outcome)
	}
	if f.Body != "" {
		fmt.Fprintf(&sb, "\n%s\n", f.Body)
	}
	return sb.String()
}

// formatDeps formats dependencies with labels and optional titles.
// When g is non-nil, each dep includes its truncated title for context.
// When g is nil, only IDs and labels are shown.
func formatDeps(g *felt.Graph, deps felt.Dependencies) string {
	if len(deps) == 0 {
		return ""
	}

	formatOne := func(d felt.Dependency) string {
		label := ""
		if d.Label != "" {
			label = fmt.Sprintf(" [%s]", d.Label)
		}
		if g != nil {
			if f, ok := g.Nodes[d.ID]; ok {
				return fmt.Sprintf("%s%s (%s)", d.ID, label, truncateTitle(f.Title, 30))
			}
		}
		return d.ID + label
	}

	if len(deps) == 1 {
		return formatOne(deps[0])
	}

	var sb strings.Builder
	for _, d := range deps {
		fmt.Fprintf(&sb, "\n  - %s", formatOne(d))
	}
	return sb.String()
}

// truncateTitle shortens a title to maxLen chars.
func truncateTitle(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen-1] + "\u2026"
}

// extractLede extracts the first substantive paragraph from a body.
// Skips a title-level heading (# ...) since it repeats the fiber title,
// then takes the first section heading (if any) plus its first paragraph.
func extractLede(body string) string {
	lines := strings.Split(body, "\n")
	var lede []string
	inParagraph := false

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)

		// Skip leading blank lines (including after a skipped title heading)
		if len(lede) == 0 && trimmed == "" {
			continue
		}

		// Skip title-level heading at the start (# but not ##)
		if len(lede) == 0 && strings.HasPrefix(trimmed, "# ") && !strings.HasPrefix(trimmed, "## ") {
			continue
		}

		// Section heading: include it, but stop if we already have paragraph content
		if strings.HasPrefix(trimmed, "#") {
			if inParagraph {
				break
			}
			lede = append(lede, line)
			continue
		}

		// Blank line between heading and paragraph: skip
		if len(lede) > 0 && !inParagraph && trimmed == "" {
			continue
		}

		// Blank line after paragraph: stop
		if inParagraph && trimmed == "" {
			break
		}

		inParagraph = true
		lede = append(lede, line)
	}

	return strings.Join(lede, "\n")
}
