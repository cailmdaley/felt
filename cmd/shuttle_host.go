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
// Precedence mirrors the Elixir daemon's own_host_id (lib/shuttle/poller.ex)
// exactly, so the CLI and the daemon it's shelled from never disagree about
// "this machine's name": explicit --host (cross-host install, an explicit
// per-invocation override — checked first because it's a deliberate ask, not
// an ambient identity source) → SHUTTLE_HOST env var → the `~/.shuttle/host`
// file (first non-empty trimmed line; path overridable via
// SHUTTLE_HOST_FILE) → os.Hostname() (last-resort OS short name, matching the
// daemon's :inet.gethostname() fallback).
//
// Deliberately no daemon round-trip: the old path called GET /api/v1/state,
// which is re-entrant when the daemon shells this CLI (the Poller is blocked
// on the subprocess, so the request times out and the fallback silently gave
// the wrong name on a host whose identity is an alias, e.g. candide vs c03).
// This resolver is pure local state, so it's correct offline and can never
// deadlock against the process that invoked it.
//
// Errors only when every source fails — an empty host would silently never
// dispatch, so fail loud instead.
func resolveOwnHost(flagVal string) (string, error) {
	if s := strings.TrimSpace(flagVal); s != "" {
		return s, nil
	}
	if env := strings.TrimSpace(os.Getenv("SHUTTLE_HOST")); env != "" {
		return env, nil
	}
	if h, ok := hostConfigFileValue(); ok {
		return h, nil
	}
	if name, err := os.Hostname(); err == nil {
		if name = strings.TrimSpace(name); name != "" {
			return name, nil
		}
	}
	return "", fmt.Errorf(
		"could not resolve a host to stamp: SHUTTLE_HOST unset, %s empty/missing, and os.Hostname() empty; pass --host <name> explicitly",
		hostConfigFilePath(),
	)
}

// hostConfigFilePath is the canonical per-host identity file: SHUTTLE_HOST_FILE
// if set, else ~/.shuttle/host. Mirrors host_config_file/0 in the Elixir poller
// so both the CLI and the daemon read the same file by default.
func hostConfigFilePath() string {
	if v := strings.TrimSpace(os.Getenv("SHUTTLE_HOST_FILE")); v != "" {
		if expanded, err := homedirExpand(v); err == nil {
			return expanded
		}
		return v
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".shuttle/host"
	}
	return home + "/.shuttle/host"
}

// homedirExpand expands a leading "~" (or "~/...") in path to the user's home
// directory, matching Elixir's Path.expand behavior for SHUTTLE_HOST_FILE.
func homedirExpand(path string) (string, error) {
	if path != "~" && !strings.HasPrefix(path, "~/") {
		return path, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if path == "~" {
		return home, nil
	}
	return home + path[1:], nil
}

// hostConfigFileValue returns the trimmed FIRST line of the host config file,
// or ("", false) when the file is absent/unreadable or that line is blank.
// First-line-only (not first non-empty line) to match host_config_file_value/0
// in the Elixir poller exactly — any divergence here recreates the split
// identity this resolver exists to prevent.
func hostConfigFileValue() (string, bool) {
	data, err := os.ReadFile(hostConfigFilePath())
	if err != nil {
		return "", false
	}
	line, _, _ := strings.Cut(string(data), "\n")
	if line = strings.TrimSpace(line); line != "" {
		return line, true
	}
	return "", false
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
