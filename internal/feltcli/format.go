package feltcli

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
// containment collapse (0 when nothing was folded). bodyOnly marks a hit whose
// query needed the fiber body.
func formatFeltTwoLine(f *felt.Felt, collapsed int, bodyOnly bool) string {
	icon := felt.StatusIcon(f.Status)

	line1 := fmt.Sprintf("%s %s\n", icon, f.ID)

	metaStr := tagSuffix(f)
	if collapsed > 0 {
		metaStr += fmt.Sprintf(" (+%d matching %s; -v to expand)", collapsed, felt.Pluralize(collapsed, "descendant", "descendants"))
	}
	if bodyOnly {
		metaStr += " [body]"
	}

	line2 := fmt.Sprintf("    %s%s\n", f.DisplayName(), metaStr)

	return line1 + line2
}

// tagSuffix renders what both two-line renderers append after the display
// name: the fiber's role as @<role>, then its tags in parentheses, each
// omitted when absent.
func tagSuffix(f *felt.Felt) string {
	var s string
	if f.Role != "" {
		s = " @" + f.Role
	}
	if len(f.Tags) > 0 {
		s += fmt.Sprintf(" (%s)", strings.Join(f.Tags, ", "))
	}
	return s
}
