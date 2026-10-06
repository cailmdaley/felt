package shuttlecli

import (
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
)

// TestStreamsSplitAsCobraDefaults pins which stream each kind of output
// reaches through Run, the binary's entry point (clistreams tests --version,
// which needs the release's version string). Help, version text and
// completion scripts are a command's output and go to stdout; usage after a
// command-line error and cobra's notices go to stderr with the error, so a
// caller parsing stdout (the daemon reads JSON there; hooks' stdout is
// meaningful) never sees them.
func TestStreamsSplitAsCobraDefaults(t *testing.T) {
	t.Parallel()
	for _, c := range []struct {
		name           string
		args           []string
		stdout, stderr string // substrings; "" means the stream must be empty
	}{
		{"flag error", []string{"ls", "--bogus"}, "", "Usage:"},
		{"arg count", []string{"agents", "resolve"}, "", "Usage:"},
		{"unknown command", []string{"bogus"}, "", "unknown command"},
		{"unknown help topic", []string{"help", "nosuch"}, "", "Unknown help topic"},
		{"--help", []string{"--help"}, "Usage:", ""},
		{"help ls", []string{"help", "ls"}, "Usage:", ""},
		{"ls -h", []string{"ls", "-h"}, "Usage:", ""},
		{"completion", []string{"completion", "bash"}, "bash completion", ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			streams := sysenvtest.Capture(env)
			Run(env, c.args)
			for _, s := range []struct{ name, got, want string }{
				{"stdout", streams.Stdout.String(), c.stdout},
				{"stderr", streams.Stderr.String(), c.stderr},
			} {
				if s.want == "" && s.got != "" {
					t.Errorf("%s should be empty, got:\n%s", s.name, s.got)
				}
				if s.want != "" && !strings.Contains(s.got, s.want) {
					t.Errorf("%s lacks %q, got:\n%s", s.name, s.want, s.got)
				}
			}
		})
	}
}
