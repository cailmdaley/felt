package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// These tests prove the trust boundary the promotion commit rests on: a
// native CLI's zero exit status is not evidence, only a cache that carries
// the promoted generation marker and digest is. The fakes behave like the
// real CLIs — they copy the registered source's payload into a private cache
// and report that path through `plugin list --json` — and the tamper modes
// make them lie the specific ways a real harness can: serving a stale cache,
// altering the payload, or never materializing the marker.

func assertRefusedBeforeCommit(t *testing.T, f *remoteSetupFixture, err error, wantGeneration string) {
	t.Helper()
	if err == nil || !strings.Contains(err.Error(), "last known-good preserved") {
		t.Fatalf("unverified cache error = %v, want refused promotion", err)
	}
	if !strings.Contains(err.Error(), "cache") {
		t.Fatalf("refusal does not name the cache boundary: %v", err)
	}
	if got := f.currentGeneration(t); got != wantGeneration {
		t.Fatalf("refused promotion replaced current generation with %q, want %q", got, wantGeneration)
	}
	runtimeDir := filepath.Join(f.home, ".felt", pluginRuntimeDirName)
	if _, statErr := os.Stat(filepath.Join(runtimeDir, pluginJournalName)); statErr == nil {
		t.Fatal("refused promotion left a pending journal")
	}
	if _, statErr := os.Stat(filepath.Join(runtimeDir, pluginPreviousName)); !os.IsNotExist(statErr) {
		t.Fatalf("refused promotion left a parked previous copy: %v", statErr)
	}
}

func TestSetupRefusesCommitOnUnverifiedNativeCache(t *testing.T) {
	for _, h := range nativeHarnesses {
		t.Run(h.name, func(t *testing.T) {
			f := newRemoteSetupFixture(t, h.name)
			if err := h.install(f.remote); err != nil {
				t.Fatalf("baseline remote %s setup: %v", h.name, err)
			}
			if got := f.currentGeneration(t); got != "one" {
				t.Fatalf("baseline generation = %q, want one", got)
			}

			for _, tamper := range []string{"stale", "alter", "missing-marker"} {
				t.Run(tamper, func(t *testing.T) {
					f.setGeneration(t, "poisoned-"+tamper)
					t.Setenv("FAKE_NATIVE_TAMPER", tamper)
					err := h.install(f.remote + "#" + tamper)
					assertRefusedBeforeCommit(t, f, err, "one")
				})
			}

			// With the lie removed the same source promotes and verifies cleanly.
			f.setGeneration(t, "honest")
			if err := h.install(f.remote + "#honest"); err != nil {
				t.Fatalf("honest retry after refused caches: %v", err)
			}
			if got := f.currentGeneration(t); got != "honest" {
				t.Fatalf("post-retry generation = %q, want honest", got)
			}
		})
	}
}

// TestClaudeSetupRecoversStaleUpdateCacheViaReinstall proves the ordinary
// dev-loop case is not bricked: `claude plugin update` on an unchanged
// version legitimately keeps the old versioned cache, and setup converges by
// falling back to uninstall+install — which re-copies — before verifying.
func TestClaudeSetupRecoversStaleUpdateCacheViaReinstall(t *testing.T) {
	f := newRemoteSetupFixture(t, "claude")
	if err := installPluginViaCLI(f.remote); err != nil {
		t.Fatalf("baseline remote Claude setup: %v", err)
	}
	baseline, err := os.ReadFile(f.nativeLog)
	if err != nil {
		t.Fatal(err)
	}
	f.setGeneration(t, "refreshed")
	t.Setenv("FAKE_NATIVE_TAMPER", "stale-update")
	if err := installPluginViaCLI(f.remote + "#refreshed"); err != nil {
		t.Fatalf("stale-update promotion did not converge via reinstall: %v", err)
	}
	if got := f.currentGeneration(t); got != "refreshed" {
		t.Fatalf("post-reinstall generation = %q, want refreshed", got)
	}
	log, err := os.ReadFile(f.nativeLog)
	if err != nil {
		t.Fatal(err)
	}
	// Only the second setup's log lines count: the baseline already logged a
	// plain install, so an unscoped assertion would pass without any fallback.
	delta := strings.TrimPrefix(string(log), string(baseline))
	if !strings.Contains(delta, "plugin uninstall") || !strings.Contains(delta, "plugin install") {
		t.Fatalf("convergence did not go through uninstall+install:\n%s", delta)
	}
}
