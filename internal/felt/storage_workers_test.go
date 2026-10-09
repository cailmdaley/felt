package felt

import (
	"sync/atomic"
	"testing"
	"time"
)

func TestParallelFileWorkHonorsReadWorkerLimit(t *testing.T) {
	t.Setenv("FELT_READ_WORKERS", "2")
	var running, peak atomic.Int32
	parallelFileWork(12, func(int) {
		current := running.Add(1)
		for old := peak.Load(); current > old; old = peak.Load() {
			if peak.CompareAndSwap(old, current) {
				break
			}
		}
		time.Sleep(5 * time.Millisecond)
		running.Add(-1)
	})
	if got := peak.Load(); got != 2 {
		t.Fatalf("peak concurrency = %d, want 2", got)
	}
}

func TestStorageReadWorkersInvalidValuesUseDefault(t *testing.T) {
	for _, value := range []string{"", "0", "-1", "invalid"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("FELT_READ_WORKERS", value)
			if got := storageReadWorkers(); got != defaultStorageReadWorkers {
				t.Fatalf("storageReadWorkers() = %d, want %d", got, defaultStorageReadWorkers)
			}
		})
	}
}
