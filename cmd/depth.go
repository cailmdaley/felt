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
func renderFelt(f *felt.Felt, g *felt.Graph, depth string, citations []felt.Citation) string {
	switch depth {
	case DepthTitle:
		return renderTitle(f)
	case DepthCompact:
		return renderCompact(f, g)
	case DepthSummary:
		return renderSummary(f, g, citations)
	default:
		return renderFull(f, g, citations)
	}
}

func renderTitle(f *felt.Felt) string {
	if len(f.Tags) > 0 {
		return fmt.Sprintf("%s (%s)\n", f.DisplayName(), strings.Join(f.Tags, ", "))
	}
	return f.DisplayName() + "\n"
}

// writeHeader writes the common ID/Name/Status/Tags block shared by
// compact, summary, and full renderers.
func writeHeader(sb *strings.Builder, f *felt.Felt) {
	fmt.Fprintf(sb, "ID:       %s\n", f.ID)
	fmt.Fprintf(sb, "Name:     %s\n", f.DisplayName())
	if f.HasStatus() {
		fmt.Fprintf(sb, "Status:   %s\n", f.Status)
	}
	if len(f.Tags) > 0 {
		fmt.Fprintf(sb, "Tags:     %s\n", strings.Join(f.Tags, ", "))
	}
}

func renderCompact(f *felt.Felt, g *felt.Graph) string {
	var sb strings.Builder
	writeHeader(&sb, f)
	if f.Outcome != "" {
		fmt.Fprintf(&sb, "Outcome:  %s\n", f.Outcome)
	}
	writeASTRACounts(&sb, f)
	return sb.String()
}

func renderSummary(f *felt.Felt, g *felt.Graph, citations []felt.Citation) string {
	var sb strings.Builder
	writeHeader(&sb, f)
	if f.Due != nil {
		fmt.Fprintf(&sb, "Due:      %s\n", f.Due.Format("2006-01-02"))
	}
	if f.Outcome != "" {
		fmt.Fprintf(&sb, "Outcome:  %s\n", f.Outcome)
	}
	writeBodyRefs(&sb, f, g)
	writeCitations(&sb, citations)
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

func writeASTRACounts(sb *strings.Builder, f *felt.Felt) {
	var parts []string
	if len(f.Decisions) > 0 {
		parts = append(parts, fmt.Sprintf("%d decisions", len(f.Decisions)))
	}
	if len(f.Inputs) > 0 {
		parts = append(parts, fmt.Sprintf("%d inputs", len(f.Inputs)))
	}
	if len(f.Outputs) > 0 {
		parts = append(parts, fmt.Sprintf("%d outputs", len(f.Outputs)))
	}
	if len(f.Insights) > 0 {
		parts = append(parts, fmt.Sprintf("%d insights", len(f.Insights)))
	}
	if len(parts) > 0 {
		fmt.Fprintf(sb, "ASTRA:    %s\n", strings.Join(parts, ", "))
	}
}

func renderFull(f *felt.Felt, g *felt.Graph, citations []felt.Citation) string {
	var sb strings.Builder
	writeHeader(&sb, f)
	writeBodyRefs(&sb, f, g)
	writeCitations(&sb, citations)
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

func writeCitations(sb *strings.Builder, citations []felt.Citation) {
	if len(citations) == 0 {
		return
	}
	parts := make([]string, 0, len(citations))
	for _, citation := range citations {
		ref := citation.SourceID
		if citation.Fragment != "" {
			ref += "#" + citation.Fragment
		}
		if strings.TrimSpace(citation.SourceName) != "" {
			ref += " (" + truncateTitle(citation.SourceName, 30) + ")"
		}
		parts = append(parts, ref)
	}
	fmt.Fprintf(sb, "Cited by: %s\n", strings.Join(parts, ", "))
}

// writeBodyRefs extracts markdown and wikilinks from the body and renders them
// as a "Refs:" line, annotating which ones resolve to known fibers.
func writeBodyRefs(sb *strings.Builder, f *felt.Felt, g *felt.Graph) {
	if f.Body == "" {
		return
	}
	refs := felt.ExtractBodyRefs(f.Body)
	if len(refs) == 0 {
		return
	}
	var parts []string
	var ids []string
	if g != nil {
		ids = make([]string, 0, len(g.Nodes))
		for id := range g.Nodes {
			ids = append(ids, id)
		}
	}
	for _, ref := range refs {
		if g != nil {
			if resolved, err := felt.ResolveScopedID(ids, f.ID, ref.Target); err == nil {
				if node, ok := g.Nodes[resolved]; ok {
					label := resolved
					if ref.Fragment != "" {
						label += "#" + ref.Fragment
					}
					parts = append(parts, fmt.Sprintf("%s (%s)", label, truncateTitle(node.DisplayName(), 30)))
					continue
				}
			}
		}
		if ref.Fragment != "" {
			parts = append(parts, ref.String())
			continue
		}
		parts = append(parts, ref.Target)
		if g != nil {
			if node, ok := g.Nodes[ref.Target]; ok {
				parts[len(parts)-1] = fmt.Sprintf("%s (%s)", ref.Target, truncateTitle(node.DisplayName(), 30))
				continue
			}
		}
	}
	fmt.Fprintf(sb, "Refs:     %s\n", strings.Join(parts, ", "))
}

func truncateTitle(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen-1] + "\u2026"
}

// extractLede extracts the first substantive paragraph from a body.
// Skips a title-level heading (# ...) since it repeats the fiber name,
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
