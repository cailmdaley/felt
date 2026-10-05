package feltcli

import (
	"strings"
	"testing"
)

// TestEmptyResultsSayWhatTheyMean: the store holds fibers, and an empty ls or
// find says so in those words.
func TestEmptyResultsSayWhatTheyMean(t *testing.T) {
	t.Parallel()
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

}
