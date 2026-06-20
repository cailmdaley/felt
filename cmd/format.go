package cmd

import (
	"fmt"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
)

// formatFeltTwoLine returns a felt in two-line format:
// Line 1: status icon + ID
// Line 2: indented name with metadata (tags)
func formatFeltTwoLine(f *felt.Felt) string {
	icon := felt.StatusIcon(f.Status)

	line1 := fmt.Sprintf("%s %s\n", icon, f.ID)

	metaStr := ""
	if len(f.Tags) > 0 {
		metaStr = fmt.Sprintf(" (%s)", strings.Join(f.Tags, ", "))
	}

	line2 := fmt.Sprintf("    %s%s\n", f.DisplayName(), metaStr)

	return line1 + line2
}
