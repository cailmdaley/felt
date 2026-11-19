package shuttlecli

import (
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

// A closed constitution takes and loses a channel, and nothing else in its
// document moves.
func TestShuttleChannelSetsAndClearsOnAClosedConstitution(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	block := oneshot()
	block["runtime"] = map[string]any{"handed_off_at": "2026-11-01T10:00:00Z"}
	tempered := true
	seedShuttleRole(t, storage, "hub", felt.StatusClosed, block, &tempered)
	before := readFile(t, storage.Path("hub"))

	for _, name := range []string{"true", "a: b", "  Cosmic shear #2  "} {
		if out, err := runIn(t, env, dir, "channel", "hub", name); err != nil {
			t.Fatalf("channel %q: %v\n%s", name, err, out)
		}
		want := strings.TrimSpace(name)
		if got := officeOf(t, storage, "hub").Channel; got != want {
			t.Fatalf("channel %q read back as %q", name, got)
		}
		var kept []string
		for _, line := range strings.Split(readFile(t, storage.Path("hub")), "\n") {
			if !strings.Contains(line, "channel:") {
				kept = append(kept, line)
			}
		}
		if strings.Join(kept, "\n") != before {
			t.Fatalf("channel %q changed more than its key:\n%s", name, readFile(t, storage.Path("hub")))
		}
	}

	if out, err := runIn(t, env, dir, "channel", "hub", "--clear"); err != nil {
		t.Fatalf("channel --clear: %v\n%s", err, out)
	}
	if after := readFile(t, storage.Path("hub")); after != before {
		t.Fatalf("clear did not restore the document:\n%s", after)
	}
}

func TestShuttleChannelRefusesInvalidArgumentsWithoutWriting(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "hub", felt.StatusOpen, oneshot(), nil)
	seedPlainFiber(t, storage, "note", felt.StatusOpen)
	before := readFile(t, storage.Path("hub"))
	for _, args := range [][]string{
		{"channel", "hub"}, {"channel", "hub", ""}, {"channel", "hub", "   "},
		{"channel", "hub", "two\nlines"}, {"channel", "hub", "name", "--clear"},
		{"channel", "note", "name"},
	} {
		if _, err := runIn(t, env, dir, args...); err == nil {
			t.Fatalf("%q: accepted", args)
		}
	}
	if after := readFile(t, storage.Path("hub")); after != before {
		t.Fatalf("refused channel wrote the fiber:\n%s", after)
	}
}
