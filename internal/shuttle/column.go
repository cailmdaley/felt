package shuttle

import (
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"gopkg.in/yaml.v3"
)

// TemperedKey is the top-level frontmatter key holding the human review
// verdict: true tempered, false discarded, absent awaiting review.
const TemperedKey = "tempered"

// Tempered returns the fiber's review verdict, nil when it has none.
func Tempered(f *felt.Felt) *bool {
	node, ok := f.ExtraFields[TemperedKey]
	if !ok || node == nil || node.Kind != yaml.ScalarNode {
		return nil
	}
	var v bool
	if err := node.Decode(&v); err != nil {
		return nil
	}
	return &v
}

// Verdict names a closed fiber's review verdict ("tempered" or "discarded"),
// or "" when it has none.
func Verdict(f *felt.Felt) string {
	if f.Status != felt.StatusClosed {
		return ""
	}
	switch v := Tempered(f); {
	case v == nil:
		return ""
	case *v:
		return "tempered"
	default:
		return "discarded"
	}
}

// Column is the Desk column the board files a constitution in
// (ui/src/board/deskColumn.ts): drafts, in_flight, awaiting_review, tempered,
// discarded, resting (a draft put down, or a standing constitution between
// firings) or roles (a seat at rest). live is whether its worker runs; today
// is the civil day a due date is read against. The daemon's thread roster
// files by the same rules (Shuttle.Threads.column/2), and
// daemon/test/fixtures/columns holds the three classifiers equal.
func Column(f *felt.Felt, block *Block, live bool, today time.Time) string {
	if f.Status == felt.StatusClosed {
		if verdict := Verdict(f); verdict != "" {
			return verdict
		}
		return "awaiting_review"
	}
	switch {
	case live:
		return "in_flight"
	case block.Seat && block.Role != "" && (f.Status != felt.StatusActive || block.Kind == "standing"):
		return "roles"
	case f.Status == felt.StatusActive && block.Kind == "standing":
		return "resting"
	case f.Status == felt.StatusActive:
		return "in_flight"
	case stashed(f, today):
		return "resting"
	default:
		return "drafts"
	}
}

// stashed reports a fiber put down (horizon: stashed) that no due day which
// has come pulls back onto the desk.
func stashed(f *felt.Felt, today time.Time) bool {
	node, ok := f.ExtraFields["horizon"]
	if !ok || node == nil || node.Kind != yaml.ScalarNode || node.Value != "stashed" {
		return false
	}
	return f.Due == nil || f.Due.UTC().Format(time.DateOnly) > today.Format(time.DateOnly)
}
