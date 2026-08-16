package cmd

import (
	"fmt"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
)

// formatFeltTwoLine returns a felt in two-line format:
// Line 1: status icon + ID
// Line 2: indented name with metadata (tags)
//
// collapsed is the number of matching descendants folded into this line by the
// containment collapse (0 when nothing was folded).
func formatFeltTwoLine(f *felt.Felt, collapsed int) string {
	icon := felt.StatusIcon(f.Status)

	line1 := fmt.Sprintf("%s %s\n", icon, f.ID)

	metaStr := ""
	if len(f.Tags) > 0 {
		metaStr = fmt.Sprintf(" (%s)", strings.Join(f.Tags, ", "))
	}
	if collapsed > 0 {
		metaStr += fmt.Sprintf(" (+%d matching %s; -v to expand)", collapsed, pluralize(collapsed, "descendant", "descendants"))
	}

	line2 := fmt.Sprintf("    %s%s\n", f.DisplayName(), metaStr)

	return line1 + line2
}
