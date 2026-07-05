package cmd

import (
	"sync"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

// TestStampHandedOff_ConcurrentWithStorageRMW is the F4 keystone at the layer
// handoff actually operates at: `felt shuttle handoff` (stampHandedOff, which
// locks+reads+writes the raw file at SHUTTLE_FIBER_PATH, bypassing Storage
// entirely) racing a daemon-shelled `felt shuttle mark-runtime`-shaped write
// (Storage.LockFiber -> Storage.Read -> SetShuttleRuntimeField -> Storage.Write)
// against the SAME fiber file. This is exactly the production race F4 exists
// to close: a worker's clean-exit handoff landing at the same instant the
// daemon shells mark-runtime to stamp a dispatch/conclude field.
//
// Both sides key their lock off the same on-disk path (Storage.Path(id) is
// what a real daemon-shelled invocation would resolve to, and what
// SHUTTLE_FIBER_PATH names for a worker), so they must serialize through the
// same lock file rather than each acquiring an independent one.
func TestStampHandedOff_ConcurrentWithStorageRMW(t *testing.T) {
	_, storage := newShuttleStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusActive, oneshot(), nil)
	seeded := mustRead(t, storage, "f")
	if err := seeded.SetExtraField("counters", map[string]any{"run_id": 0}); err != nil {
		t.Fatalf("seeding counters: %v", err)
	}
	if err := storage.Write(seeded); err != nil {
		t.Fatalf("writing seeded counters: %v", err)
	}

	path := storage.Path("f")

	const iterations = 20
	var wg sync.WaitGroup
	wg.Add(2)

	// Side A: the worker's clean-exit handoff, called repeatedly (in reality
	// this fires once per worker lifetime; iterating here just gives the race
	// detector and the lock more opportunities to contend).
	go func() {
		defer wg.Done()
		for i := 0; i < iterations; i++ {
			if _, err := stampHandedOff(path); err != nil {
				t.Errorf("stampHandedOff: %v", err)
				return
			}
		}
	}()

	// Side B: a mark-runtime-shaped RMW (lock -> read -> mutate one field ->
	// write -> unlock) bumping a counter, mirroring exactly what
	// resolveOwnedShuttleFiberAs + SetShuttleRuntimeField + Storage.Write do in
	// cmd/shuttle_mark_runtime.go's RunE.
	go func() {
		defer wg.Done()
		for i := 0; i < iterations; i++ {
			unlock, err := storage.LockFiber("f")
			if err != nil {
				t.Errorf("LockFiber: %v", err)
				return
			}
			f, err := storage.Read("f")
			if err != nil {
				unlock()
				t.Errorf("Read: %v", err)
				return
			}
			var counters map[string]any
			if err := f.ExtraFields["counters"].Decode(&counters); err != nil {
				unlock()
				t.Errorf("decoding counters: %v", err)
				return
			}
			n, _ := counters["run_id"].(int)
			counters["run_id"] = n + 1
			if err := f.SetExtraField("counters", counters); err != nil {
				unlock()
				t.Errorf("SetExtraField: %v", err)
				return
			}
			if err := storage.Write(f); err != nil {
				unlock()
				t.Errorf("Write: %v", err)
				return
			}
			if err := unlock(); err != nil {
				t.Errorf("unlock: %v", err)
				return
			}
		}
	}()

	wg.Wait()

	final := mustRead(t, storage, "f")

	// Side A's field must have landed (a bare non-empty timestamp is enough
	// proof stampHandedOff's writes weren't entirely lost).
	rt := shuttleRuntimeMap(t, final)
	if got, _ := rt["handed_off_at"].(string); got == "" {
		t.Fatal("shuttle.runtime.handed_off_at is empty after the race — handoff's writes were lost")
	}

	// Side B's counter must reflect EVERY iteration — the actual lost-update
	// check. Without the lock, this reliably comes up short: whichever side
	// wrote from a stale read clobbers the other's most recent value.
	var counters map[string]any
	if err := final.ExtraFields["counters"].Decode(&counters); err != nil {
		t.Fatalf("decoding final counters: %v", err)
	}
	if n, _ := counters["run_id"].(int); n != iterations {
		t.Fatalf("counters.run_id = %d, want %d — lost update(s) under concurrent handoff/mark-runtime writes", n, iterations)
	}
}
