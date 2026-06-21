package cmd

import (
	"fmt"
	"os"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
)

// resolveOwnHost determines the host id to stamp on a freshly installed block,
// and the identity the ownership guard compares against. A block is born owned:
// every install/repeat/pin writes an explicit host: so the daemon's strict
// dispatch predicate (block.host == own_host_id) has a value to match, and no
// host-less block is produced by normal flows.
//
// Precedence: explicit --host (cross-host install) → the local daemon's
// own_host_id via GET /api/v1/state .host (the authoritative identity the poller
// compares against; the common path) → SHUTTLE_HOST env (the same override the
// daemon honors; keeps install working when the daemon is briefly down) →
// os.Hostname() (last-resort OS short name, matching the daemon's own
// :inet.gethostname() fallback). Errors only when every source fails — an empty
// host would silently never dispatch, so fail loud instead.
func resolveOwnHost(flagVal string) (string, error) {
	if s := strings.TrimSpace(flagVal); s != "" {
		return s, nil
	}
	if h, err := fetchLocalHost(); err == nil {
		if h = strings.TrimSpace(h); h != "" {
			return h, nil
		}
	}
	if env := strings.TrimSpace(os.Getenv("SHUTTLE_HOST")); env != "" {
		return env, nil
	}
	if name, err := os.Hostname(); err == nil {
		if name = strings.TrimSpace(name); name != "" {
			return name, nil
		}
	}
	return "", fmt.Errorf(
		"could not resolve a host to stamp: daemon unreachable at %s, SHUTTLE_HOST unset, and os.Hostname() empty; pass --host <name> explicitly",
		daemonURL(),
	)
}

// ownerMismatchError is returned by ensureOwnedHere when a write verb runs
// against a fiber owned by a different daemon. A distinct type so callers and
// tests can assert the guard fired rather than string-matching the message.
type ownerMismatchError struct {
	fiber, owner, own string
}

func (e ownerMismatchError) Error() string {
	return fmt.Sprintf(
		"fiber %s is owned by host %q, but this daemon is %q.\n"+
			"  Refusing to write the local git-sync mirror — that desyncs the owner's\n"+
			"  copy and resurrects on the next loom sync (single-writer-per-fiber).\n"+
			"  Run this verb on %q, or use the kanban (it routes to the owning daemon).",
		e.fiber, e.owner, e.own, e.owner)
}

// ensureOwnedHere refuses to mutate a fiber whose shuttle.host names a daemon
// other than this machine. Under loom git-sync the same fiber file exists on
// every host, so a bare write on the wrong machine resolves the LOCAL mirror and
// writes it — split-brain that only git-sync reconciles, lazily and sometimes
// wrongly (the resurrecting tempered-card bug). The owning daemon is the single
// writer; cross-host lifecycle must reach it (the kanban routes there).
//
// Best-effort, fail-open: a fiber with no/invalid shuttle block, a host-less
// block (legacy, pre-"born-owned"), or an unresolvable own-host identity falls
// through to a normal local write rather than hard-blocking. The guard closes the
// known mirror-write footgun; it is not a gate on every edit.
func ensureOwnedHere(f *felt.Felt, fiber string) error {
	return ensureOwnedHereAs(f, fiber, "")
}

// ensureOwnedHereAs is ensureOwnedHere with an explicit own-host. When
// ownHostOverride is non-empty it is used directly and resolveOwnHost is NOT
// consulted — the daemon passes its authoritative own_host_id via
// `mark-runtime --host` so the ownership check needs no round-trip back to
// GET /api/v1/state. That callback is re-entrant for a daemon-shelled write
// (the Poller is blocked on the felt subprocess, so /api/v1/state times out and
// resolveOwnHost falls back to os.Hostname() — wrong on a host whose owner id is
// an alias, e.g. candide vs c03 — silently failing the write). An empty override
// preserves the original resolveOwnHost precedence for human-facing verbs.
func ensureOwnedHereAs(f *felt.Felt, fiber, ownHostOverride string) error {
	block, ok, err := f.ShuttleBlock()
	if err != nil || !ok || block == nil {
		return nil
	}
	owner := strings.TrimSpace(block.Host)
	if owner == "" {
		return nil
	}
	own := strings.TrimSpace(ownHostOverride)
	if own == "" {
		resolved, err := resolveOwnHost("")
		if err != nil {
			return nil
		}
		own = strings.TrimSpace(resolved)
	}
	if own == "" || owner == own {
		return nil
	}
	return ownerMismatchError{fiber: fiber, owner: owner, own: own}
}
