package cmd

import (
	"fmt"
	"os"
	"path/filepath"
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
// exactly: explicit --host (cross-host install, an explicit per-invocation
// override — checked first because it's a deliberate ask, not an ambient
// identity source) → SHUTTLE_HOST env var → the `~/.shuttle/host` file (its
// trimmed first line; path overridable via SHUTTLE_HOST_FILE) →
// os.Hostname(), normalized and then WRITTEN BACK to the host file.
//
// Mirroring the chain was not enough on its own. The first three tiers are
// stable values two processes can agree on; the OS hostname is neither. It
// varies across runtimes — Erlang's :inet.gethostname() reports the short
// name, os.Hostname() keeps the DNS domain, so the same Mac is
// "studio-macbook-air" to the daemon and "studio-air.home" to the CLI —
// and it varies across time, because DHCP rewrites it on some networks. Under
// the strict dispatch predicate (block.host == own_host_id) either kind of
// drift silently unhomes every fiber the CLI armed: the daemon sees a host it
// isn't, dispatches nothing, and reports nothing wrong.
//
// So the OS hostname is consulted once per machine and then retired. It is
// normalized identically on both sides (trimmed, lowercased, truncated at the
// first "."), and seeded into the host-config path, which every later resolve
// on either side reads instead. Whoever reaches the fallback first fixes the
// name; agreement is the point, not which name won. Seeding is best-effort —
// a read-only home, or a machine with no ~/.shuttle at all, still resolves,
// just without the durability.
//
// Deliberately no daemon round-trip: the old path called GET /api/v1/state,
// which is re-entrant when the daemon shells this CLI (the Poller is blocked
// on the subprocess, so the request times out and the fallback silently gave
// the wrong name on a host whose identity is an alias, e.g. a friendly name
// vs the raw login-node hostname).
// This resolver is pure local state, so it's correct offline and can never
// deadlock against the process that invoked it.
//
// Errors only when every source fails — an empty host would silently never
// dispatch, so fail loud instead.
func resolveOwnHost(flagVal string) (string, error) {
	host, _, err := resolveOwnHostSourced(flagVal)
	return host, err
}

// hostSource names the tier of resolveOwnHost's precedence that answered, so a
// message about the identity can point at the thing that actually decided it
// rather than at the file that may be sitting underneath an override.
type hostSource string

const (
	hostSourceFlag     hostSource = "--host"
	hostSourceEnv      hostSource = "SHUTTLE_HOST"
	hostSourceFile     hostSource = "file"
	hostSourceHostname hostSource = "hostname"
)

// describe renders the source for a user-facing message. The file tier names
// the resolved path (the user can edit it); the hostname tier names both,
// because a hostname-derived identity has just been seeded into that path.
func (s hostSource) describe() string {
	switch s {
	case hostSourceFlag:
		return "--host"
	case hostSourceEnv:
		return "$SHUTTLE_HOST"
	case hostSourceHostname:
		return "the OS hostname, seeded into " + hostConfigFilePath()
	default:
		return hostConfigFilePath()
	}
}

// resolveOwnHostSourced is resolveOwnHost plus the tier that answered.
func resolveOwnHostSourced(flagVal string) (string, hostSource, error) {
	if s := strings.TrimSpace(flagVal); s != "" {
		return s, hostSourceFlag, nil
	}
	if env := strings.TrimSpace(os.Getenv("SHUTTLE_HOST")); env != "" {
		return env, hostSourceEnv, nil
	}
	if h, ok := hostConfigFileValue(); ok {
		return h, hostSourceFile, nil
	}
	if name, err := osHostname(); err == nil {
		if name = normalizeHostname(name); name != "" {
			seedHostConfigFile(name)
			return name, hostSourceHostname, nil
		}
	}
	return "", "", fmt.Errorf(
		"could not resolve a host to stamp: SHUTTLE_HOST unset, %s empty/missing, and os.Hostname() empty; pass --host <name> explicitly",
		hostConfigFilePath(),
	)
}

// osHostname is os.Hostname, indirected so tests can force the
// last-resort tier of resolveOwnHost's precedence to fail without needing an
// OS-level way to break the real hostname syscall (there isn't a portable
// one). Production code never reassigns it.
var osHostname = os.Hostname

// normalizeHostname reduces a raw OS hostname to the canonical short form both
// sides agree on: trimmed, lowercased, and cut at the first "." so
// "Studio-Air.home" and "studio-air" are the same machine. Matches
// normalize_hostname/1 in the Elixir poller; the two must not drift.
func normalizeHostname(raw string) string {
	name := strings.TrimSpace(raw)
	if i := strings.Index(name, "."); i >= 0 {
		name = name[:i]
	}
	return strings.ToLower(strings.TrimSpace(name))
}

// seedHostConfigFile persists a hostname-derived identity to the host-config
// path so it stops being derived. Called only from resolveOwnHost's last tier
// — i.e. with SHUTTLE_HOST unset and the file absent or blank — so it never
// overwrites an explicit choice. Best-effort by design: a failed write (a
// read-only home, a container with no writable $HOME) leaves the caller with
// the in-memory value rather than breaking the command.
//
// It writes only into a parent directory that ALREADY exists, and never
// creates one. That is the same gate the event stream and commit ledger use
// (shuttleSink, cmd/shuttle_events.go): the existence of ~/.shuttle is what
// distinguishes a shuttle host from a machine that installed felt for fibers
// alone. Since resolveOwnHost runs inside `felt hook event` — before the
// stream's own gate is consulted — an mkdir here would create ~/.shuttle on a
// felt-only machine and thereby switch that machine's event stream on. Seeding
// is explicitly best-effort, so declining is free; breaking the gate is not.
func seedHostConfigFile(name string) {
	path := hostConfigFilePath()
	dir := filepath.Dir(path)
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return
	}
	_ = os.WriteFile(path, []byte(name+"\n"), 0o644)
}

// hostConfigFilePath is the canonical per-host identity file: SHUTTLE_HOST_FILE
// if set, else ~/.shuttle/host. Mirrors host_config_file/0 in the Elixir poller
// so both the CLI and the daemon read the same file by default.
func hostConfigFilePath() string {
	if v := strings.TrimSpace(os.Getenv("SHUTTLE_HOST_FILE")); v != "" {
		if expanded, err := expandUserPath(v); err == nil {
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

// hostConfigFileValue returns the trimmed FIRST line of the host config file,
// or ("", false) when the file is absent/unreadable or that line is blank.
// First-line-only (not first non-empty line) to match host_config_file_value/0
// in the Elixir poller exactly — any divergence here recreates the split
// identity this file exists to prevent. This is the tier resolveOwnHost seeds
// on first fallback, so after one resolve on a fresh machine it is the tier
// that answers.
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
// source is the tier that answered for own — named in the message because the
// identity may come from an override, and telling someone to edit the host file
// when $SHUTTLE_HOST is set sends them to change something with no effect.
type ownerMismatchError struct {
	fiber, owner, own string
	source            hostSource
}

func (e ownerMismatchError) Error() string {
	return fmt.Sprintf(
		"fiber %s is owned by host %q; this machine is %q (per %s).\n"+
			"  Refusing to write the local git-sync mirror — that desyncs the owner's\n"+
			"  copy and resurrects on the next loom sync (single-writer-per-fiber).\n"+
			"  Run this verb on %q, or use the kanban (it routes to the owning daemon).\n"+
			"  If both names are THIS machine, that source is the canonical one: set\n"+
			"  the fiber's host: to match it.",
		e.fiber, e.owner, e.own, e.source.describe(), e.owner)
}

// ensureOwnedHere refuses to mutate a fiber whose shuttle.host names a daemon
// other than this machine. Under loom git-sync the same fiber file exists on
// every host, so a bare write on the wrong machine resolves the LOCAL mirror and
// writes it — split-brain that only git-sync reconciles, lazily and sometimes
// wrongly (the resurrecting tempered-card bug). The owning daemon is the single
// writer; cross-host lifecycle must reach it (the kanban routes there).
//
// Fail-open only where there is genuinely nothing to guard: a fiber with
// no/invalid shuttle block, or a host-less block (legacy, pre-"born-owned"),
// falls through to a normal local write rather than hard-blocking — the guard
// closes the known mirror-write footgun, it is not a gate on every edit.
//
// An UNRESOLVABLE own-host identity is different and fails loud (returns the
// wrapped resolveOwnHost error) rather than falling through. Pre-S1, own-host
// resolution round-tripped to the local daemon, so a resolution failure could
// mean nothing worse than "daemon briefly down" — permitting the write was the
// lesser risk. Post-S1, resolution is pure local state (env var, host file,
// os.Hostname), so a failure means those are ALL absent/empty — something
// genuinely broken, not a transient daemon hiccup. Silently permitting the
// write in that state is how a wrong-host mirror-write (and the resurrecting
// git-sync bug this guard exists to prevent) would happen invisibly; failing
// loud surfaces it instead.
// C1: previously delegated to `ensureOwnedHereAs(f, fiber, "")` — an explicit
// own-host override the daemon passed on mark-runtime/reopen so the guard
// never round-tripped back to GET /api/v1/state (re-entrant while the Poller
// is blocked on the felt subprocess). Post-S1, `resolveOwnHost` is pure local
// state (env var → host file → os.Hostname, no daemon call), so there is
// nothing left to avoid round-tripping to — every caller resolves the same
// way now.
func ensureOwnedHere(f *felt.Felt, fiber string) error {
	block, ok, err := f.ShuttleBlock()
	if err != nil || !ok || block == nil {
		return nil
	}
	owner := strings.TrimSpace(block.Host)
	if owner == "" {
		return nil
	}
	own, source, err := resolveOwnHostSourced("")
	if err != nil {
		return fmt.Errorf("cannot verify fiber %s ownership (owned by %q): %w", fiber, owner, err)
	}
	own = strings.TrimSpace(own)
	if own == "" || owner == own {
		return nil
	}
	return ownerMismatchError{fiber: fiber, owner: owner, own: own, source: source}
}
