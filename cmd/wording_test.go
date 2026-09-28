package cmd

import (
	"strings"
	"testing"
)

// TestEmptyResultsAndDraftInstallSayWhatTheyMean: the store holds fibers, and
// an empty ls or find says so in those words; a draft install's confirmation
// reads as one parenthetical.
func TestEmptyResultsAndDraftInstallSayWhatTheyMean(t *testing.T) {
	dir, _ := newStore(t)
	for _, args := range [][]string{{"ls", "nothing-here"}, {"find", "nothing-here"}} {
		out, err := runCommand(t, dir, args...)
		if err != nil {
			t.Fatalf("%v: %v\n%s", args, err, out)
		}
		if !strings.Contains(out, `No fibers matching "nothing-here"`) {
			t.Fatalf("%v output = %q, want it to speak of fibers", args, out)
		}
	}

	if out, err := runCommand(t, dir, "add", "draft", "Draft"); err != nil {
		t.Fatalf("add: %v\n%s", err, out)
	}
	out, err := runCommand(t, dir, "shuttle", "install", "draft", "--disabled")
	if err != nil {
		t.Fatalf("install --disabled: %v\n%s", err, out)
	}
	if !strings.Contains(out, "installed draft as oneshot role (draft, status: open)\n") {
		t.Fatalf("install --disabled output = %q", out)
	}
}
