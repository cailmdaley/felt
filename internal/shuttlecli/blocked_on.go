package shuttlecli

import (
	"errors"
	"fmt"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

// blockedOnKey is the shuttle-block key naming what a resting thread waits
// for: a fiber's uid, or free text.
const blockedOnKey = "blocked_on"

var dateShaped = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// restUntil is what `shuttle rest --until` names: a return day, something to
// wait for, or nothing (an undated, unblocked rest).
type restUntil struct {
	date *time.Time
	wait string
}

// parseRestUntil reads --until: a YYYY-MM-DD is a return day, any other
// single line is what the rest waits for, and ” clears both.
func parseRestUntil(raw string) (restUntil, error) {
	raw = strings.TrimSpace(raw)
	switch {
	case raw == "":
		return restUntil{}, nil
	case dateShaped.MatchString(raw):
		date, err := time.Parse("2006-01-02", raw)
		if err != nil {
			return restUntil{}, fmt.Errorf("invalid --until date %q: use a real YYYY-MM-DD", raw)
		}
		return restUntil{date: &date}, nil
	case strings.ContainsAny(raw, "\r\n"):
		return restUntil{}, fmt.Errorf("--until must be a single line")
	default:
		return restUntil{wait: raw}, nil
	}
}

// resolveBlocker turns what a rest waits for into its stored form: the uid of
// the fiber it names in this store (resolved from the thread's own place, so a
// sibling's slug is enough), else the text itself. A text naming several
// fibers is refused; one only a guess reaches is kept as text.
func resolveBlocker(st *felt.Storage, thread *felt.Felt, text string) (string, *felt.Felt, error) {
	scope := path.Dir(thread.ID)
	if scope == "." {
		scope = ""
	}
	f, err := st.FindMetadataWithoutGuessing(scope, text)
	var ambiguous *felt.AmbiguousFiberError
	switch {
	case errors.As(err, &ambiguous):
		return "", nil, fmt.Errorf("--until %q names several fibers (%s); say which", text, strings.Join(ambiguous.Candidates, ", "))
	case err != nil || f == nil:
		return text, nil, nil
	case f.ID == thread.ID:
		return "", nil, fmt.Errorf("a constitution cannot rest until itself")
	case f.UID != "":
		return f.UID, f, nil
	default:
		return f.ID, f, nil
	}
}

// blockedOn is the raw value of a fiber's shuttle.blocked_on, or "".
func blockedOn(f *felt.Felt) string {
	block, ok, err := shuttle.BlockOf(f)
	if err != nil || !ok {
		return ""
	}
	return block.BlockedOn
}

// blockerName is what a stored blocked_on reads as: the current name of the
// fiber it names, else the stored text.
func blockerName(st *felt.Storage, value string) string {
	if value == "" || st == nil {
		return value
	}
	if !isSessionULID(value) && !strings.Contains(value, "/") {
		return value
	}
	if f, _, err := st.FindExistingMetadataInScope("", value); err == nil && f != nil {
		return shuttleNonEmpty(f.Name, f.ID)
	}
	if f, err := st.FindMetadataWithoutGuessing("", value); err == nil && f != nil && (f.UID == value || f.ID == value) {
		return shuttleNonEmpty(f.Name, f.ID)
	}
	return value
}

// clearBlockedOn drops a fiber's wait: arming or closing it ends the rest.
func clearBlockedOn(f *felt.Felt) error {
	if blockedOn(f) == "" {
		return nil
	}
	return shuttle.SetNodeField(f, blockedOnKey, nil)
}

// horizonStashed reports a fiber already put down (horizon: stashed).
func horizonStashed(f *felt.Felt) bool {
	node, ok := f.ExtraFields["horizon"]
	return ok && node != nil && node.Value == "stashed"
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
