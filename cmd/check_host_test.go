package cmd

import (
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

// TestCheckHostDrift covers the whole predicate: only a host: that normalizes
// to our own identity is drift. A different machine's name is a cross-host
// install, which is a feature and must stay silent.
func TestCheckHostDrift(t *testing.T) {
	withOwnHost(t, "studio-air")

	cases := []struct {
		name string
		host string
		warn bool
	}{
		{"dns suffix", "studio-air.home", true},
		{"uppercase", "Studio-Air", true},
		{"both", "Studio-Air.local", true},
		{"already normalized", "studio-air", false},
		{"another machine", "candide", false},
		{"unowned", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := shuttleFeltWithBlock(t, map[string]any{"agent": "claude-sonnet", "host": tc.host})
			issues := checkHostDrift([]*felt.Felt{f})
			if tc.warn {
				if len(issues) != 1 {
					t.Fatalf("host %q: got %d issues, want 1", tc.host, len(issues))
				}
				if issues[0].Level != felt.CheckLevelWarning {
					t.Fatalf("drift must warn, not fail the check: %s", issues[0].Level)
				}
				if !strings.Contains(issues[0].Message, "studio-air") {
					t.Fatalf("message should name the fix: %s", issues[0].Message)
				}
			} else if len(issues) != 0 {
				t.Fatalf("host %q: unexpected issues %v", tc.host, issues)
			}
		})
	}
}

// A fiber with no shuttle: block is not a shuttle fiber, so there is no
// identity to compare and nothing to say about it.
func TestCheckHostDriftIgnoresNonShuttleFibers(t *testing.T) {
	withOwnHost(t, "studio-air")

	f := shuttleFeltWithBlock(t, nil)
	if issues := checkHostDrift([]*felt.Felt{f}); len(issues) != 0 {
		t.Fatalf("unexpected issues %v", issues)
	}
}
