package cmd

import (
	"fmt"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
)

// Depth levels for progressive disclosure.
const (
	DepthName    = "name"
	DepthCompact = "compact"
	DepthSummary = "summary"
	DepthFull    = "full"
)

// ValidDepths lists all valid depth values.
var ValidDepths = []string{DepthName, DepthCompact, DepthSummary, DepthFull}

// refTitleMaxLen caps how many chars of a referenced fiber's title are shown
// in the Refs/Cited-by/Consumed-by parentheticals before truncation.
const refTitleMaxLen = 30

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
func renderFelt(f *felt.Felt, g *Graph, depth string, citations []felt.Citation, consumers []felt.DataFlowConsumer) string {
	switch depth {
	case DepthName:
		return renderName(f)
	case DepthCompact:
		return renderCompact(f)
	case DepthSummary:
		return renderSummary(f, g, citations, consumers)
	default:
		return renderFull(f, g, citations, consumers)
	}
}

func renderName(f *felt.Felt) string {
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

func renderCompact(f *felt.Felt) string {
	var sb strings.Builder
	writeHeader(&sb, f)
	if f.Outcome != "" {
		fmt.Fprintf(&sb, "Outcome:  %s\n", f.Outcome)
	}
	writeExtraFieldKeys(&sb, f)
	return sb.String()
}

func renderSummary(f *felt.Felt, g *Graph, citations []felt.Citation, consumers []felt.DataFlowConsumer) string {
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
	writeConsumers(&sb, consumers)
	writeExtraFieldKeys(&sb, f)
	if f.Body != "" {
		lede := extractLede(f.Body)
		fmt.Fprintf(&sb, "\n%s\n", lede)
		if remaining := len(f.Body) - len(lede); remaining > 0 {
			fmt.Fprintf(&sb, "[... %d more chars]\n", remaining)
		}
	}
	return sb.String()
}

func renderFull(f *felt.Felt, g *Graph, citations []felt.Citation, consumers []felt.DataFlowConsumer) string {
	var sb strings.Builder
	writeHeader(&sb, f)
	writeBodyRefs(&sb, f, g)
	writeCitations(&sb, citations)
	writeConsumers(&sb, consumers)
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
	writeExtraFrontmatter(&sb, f)
	if f.Body != "" {
		fmt.Fprintf(&sb, "\n%s\n", f.Body)
	}
	return sb.String()
}

func writeExtraFieldKeys(sb *strings.Builder, f *felt.Felt) {
	keys := f.ExtraFieldKeys()
	if len(keys) == 0 {
		return
	}
	fmt.Fprintf(sb, "Frontmatter: %s\n", strings.Join(keys, ", "))
}

func writeExtraFrontmatter(sb *strings.Builder, f *felt.Felt) {
	raw := strings.TrimSpace(f.ExtraFieldsYAML())
	if raw == "" {
		return
	}
	sb.WriteString("\nFrontmatter:\n")
	for _, line := range strings.Split(raw, "\n") {
		if line == "" {
			sb.WriteString("\n")
			continue
		}
		sb.WriteString("  " + line + "\n")
	}
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
			ref += " (" + truncateTitle(citation.SourceName, refTitleMaxLen) + ")"
		}
		parts = append(parts, ref)
	}
	fmt.Fprintf(sb, "Cited by: %s\n", strings.Join(parts, ", "))
}

func writeConsumers(sb *strings.Builder, consumers []felt.DataFlowConsumer) {
	if len(consumers) == 0 {
		return
	}
	parts := make([]string, 0, len(consumers))
	for _, consumer := range consumers {
		ref := consumer.SourceID
		if consumer.InputID != "" {
			ref += "#" + consumer.InputID
		}
		if strings.TrimSpace(consumer.SourceName) != "" {
			ref += " (" + truncateTitle(consumer.SourceName, refTitleMaxLen) + ")"
		}
		if consumer.OutputID != "" {
			ref = consumer.OutputID + " \u2192 " + ref
		}
		parts = append(parts, ref)
	}
	fmt.Fprintf(sb, "Consumed by: %s\n", strings.Join(parts, ", "))
}

// writeBodyRefs extracts markdown and wikilinks from the body and renders them
// as a "Refs:" line, annotating which ones resolve to known fibers.
func writeBodyRefs(sb *strings.Builder, f *felt.Felt, g *Graph) {
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
					parts = append(parts, fmt.Sprintf("%s (%s)", label, truncateTitle(node.DisplayName(), refTitleMaxLen)))
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
				parts[len(parts)-1] = fmt.Sprintf("%s (%s)", ref.Target, truncateTitle(node.DisplayName(), refTitleMaxLen))
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
