package shuttlecli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// Many hooks that all find the stream over the threshold at once must rotate
// it once: the full file becomes .1 and every new line lands in the fresh live
// file. A second rename would move that fresh file over .1 and lose the
// history it replaced.
func TestEventRotationUnderConcurrentWriters(t *testing.T) {
	const writers = 64
	t.Setenv("SHUTTLE_EVENTS_MAX_BYTES", "4096")
	full := bytes.Repeat([]byte(strings.Repeat("x", 63)+"\n"), 64) // exactly 4096 bytes

	for round := 0; round < 30; round++ {
		path := filepath.Join(t.TempDir(), "events.jsonl")
		if err := os.WriteFile(path, full, 0o644); err != nil {
			t.Fatal(err)
		}

		var start, done sync.WaitGroup
		start.Add(1)
		for i := 0; i < writers; i++ {
			done.Add(1)
			go func() {
				defer done.Done()
				start.Wait()
				if err := appendEventLine(path, "{\"type\":\"stop\"}\n"); err != nil {
					t.Error(err)
				}
			}()
		}
		start.Done()
		done.Wait()

		rotated, err := os.ReadFile(path + eventsRotatedSuffix)
		if err != nil {
			t.Fatalf("round %d: %v", round, err)
		}
		if !bytes.Equal(rotated, full) {
			t.Fatalf("round %d: .1 is %d bytes, want the %d-byte file it rotated", round, len(rotated), len(full))
		}
		live, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if n := strings.Count(string(live), "\n"); n != writers {
			t.Fatalf("round %d: live file has %d lines, want %d", round, n, writers)
		}
	}
}
