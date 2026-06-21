package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"gopkg.in/yaml.v3"
)

// felt-native field helpers shared by the shuttle write verbs. A fiber's
// lifecycle state lives in felt-native fields, NOT in the shuttle: block: status
// (the sole dispatch gate) is f.Status, closed-at is f.ClosedAt, and the human
// verdict `tempered` is a top-level ExtraField. These helpers mirror shuttle-ctl's
// FiberFile setters onto felt's data model so the ported verbs read/write the
// same fields the board and daemon already interpret.

// shuttleTemperedKey is the top-level frontmatter key holding the human review
// verdict (true=accepted, false=composted, absent=awaiting review).
const shuttleTemperedKey = "tempered"

// readTempered returns the fiber's tempered verdict: a *bool that is nil when the
// key is absent (awaiting review), matching shuttle-ctl's FiberFile.Tempered().
func readTempered(f *felt.Felt) *bool {
	node, ok := f.ExtraFields[shuttleTemperedKey]
	if !ok || node == nil || node.Kind != yaml.ScalarNode {
		return nil
	}
	var v bool
	if err := node.Decode(&v); err != nil {
		return nil
	}
	return &v
}

// setTempered writes (true/false) or clears (nil) the tempered verdict. A nil
// value removes the key entirely — the "awaiting review" state — via felt's
// whole-key SetExtraField(key, nil); a non-nil value is written as a real !!bool.
func setTempered(f *felt.Felt, value *bool) error {
	if value == nil {
		return f.SetExtraField(shuttleTemperedKey, nil)
	}
	return f.SetExtraField(shuttleTemperedKey, *value)
}

// clearClosedAt drops the native closed-at field (a fiber returning to
// open/active is no longer closed).
func clearClosedAt(f *felt.Felt) {
	f.ClosedAt = nil
}

// setClosedAtIfMissing stamps closed-at = now only when it is absent, matching
// shuttle-ctl: re-closing a fiber preserves the original close time.
func setClosedAtIfMissing(f *felt.Felt) {
	if f.ClosedAt == nil {
		now := time.Now().UTC()
		f.ClosedAt = &now
	}
}

// parseOptionalBool parses the --tempered flag: "true"/"false" → *bool, "" → nil
// (clear the verdict, i.e. awaiting review).
func parseOptionalBool(raw string) (*bool, error) {
	switch raw {
	case "true":
		v := true
		return &v, nil
	case "false":
		v := false
		return &v, nil
	case "":
		return nil, nil
	default:
		return nil, fmt.Errorf("must be true or false, got %q", raw)
	}
}

// shuttleNonEmpty returns fallback when s is empty, else s — used in status
// reporting to render "(missing)" for an empty status field.
func shuttleNonEmpty(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

// resolveProjectDirFlag expands and validates a --project-dir value: $ENV and ~
// expansion, absolute resolution, and an existence + is-directory check, so an
// install fails loud here rather than at dispatch on a non-existent cwd.
func resolveProjectDirFlag(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", fmt.Errorf("--project-dir is required")
	}
	expanded := os.ExpandEnv(raw)
	if expanded == "~" || strings.HasPrefix(expanded, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolving ~ in project dir: %w", err)
		}
		if expanded == "~" {
			expanded = home
		} else {
			expanded = filepath.Join(home, expanded[2:])
		}
	}
	abs, err := filepath.Abs(expanded)
	if err != nil {
		return "", fmt.Errorf("resolving project dir %q: %w", raw, err)
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("project dir %q: %w", abs, err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("project dir %q is not a directory", abs)
	}
	return abs, nil
}
