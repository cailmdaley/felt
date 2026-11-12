//go:build !windows

package shuttlecli

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestEventAppendWaitsForRotationBarrier(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "events")
	if err := os.WriteFile(path, []byte("old\n"), 0644); err != nil {
		t.Fatal(err)
	}
	unlock, _ := lockEventsRotation(path+eventsLockSuffix, time.Second)
	locked := true
	defer func() {
		if locked {
			unlock()
		}
	}()
	a := newApp(testEnv(t))
	result := make(chan error, 1)
	go func() { result <- a.appendEventLine(path, "stop\n") }()
	select {
	case err := <-result:
		t.Fatalf("append crossed held rotation barrier: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if err := os.Rename(path, path+eventsRotatedSuffix); err != nil {
		t.Fatal(err)
	}
	unlock()
	locked = false
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil || string(b) != "stop\n" {
		t.Fatalf("live file = %q, %v", b, err)
	}
}

// A holder stuck past the wait costs the waiting writer its line, not its
// session; the abandoned request hands the lock back once it is granted, so
// the next writer is not blocked by it.
func TestEventAppendDropsLinePastLockWait(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "events")
	unlock, _ := lockEventsRotation(path+eventsLockSuffix, time.Second)
	a := newApp(testEnv(t))
	a.eventsLockWait = 50 * time.Millisecond
	if err := a.appendEventLine(path, "dropped\n"); err == nil {
		t.Fatal("append returned without the lock")
	}
	unlock()
	a.eventsLockWait = 5 * time.Second
	if err := a.appendEventLine(path, "kept\n"); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil || string(b) != "kept\n" {
		t.Fatalf("live file = %q, %v", b, err)
	}
}
