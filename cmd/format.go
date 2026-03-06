package cmd

import (
	"fmt"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
)

// formatFeltTwoLine returns a felt in two-line format:
// Line 1: status icon + ID
// Line 2: indented title with metadata (tags, deps)
func formatFeltTwoLine(f *felt.Felt) string {
	icon := felt.StatusIcon(f.Status)

	line1 := fmt.Sprintf("%s %s\n", icon, f.ID)

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
