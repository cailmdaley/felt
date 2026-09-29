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
// This is the one host-identity resolver. The daemon does not re-derive it: its
// Poller asks `felt shuttle host --json` once at boot (unless SHUTTLE_HOST is
// set) and freezes the answer, and `bin/shuttle install-agent` runs `felt
// shuttle host seed`. So the CLI's stamp and the daemon's dispatch predicate
// cannot disagree about which machine this is.
//
// Precedence: explicit --host (cross-host install, an explicit per-invocation
// override — checked first because it's a deliberate ask, not an ambient
// identity source) → SHUTTLE_HOST env var (trimmed) → the `~/.shuttle/host`
// file (its trimmed first line; path overridable via SHUTTLE_HOST_FILE) →
// os.Hostname(), normalized and then WRITTEN BACK to the host file.
//
// The first three tiers are stable values; the OS hostname is not. It varies
// across time, because DHCP rewrites it on some networks, and under the strict
// dispatch predicate (block.host == own_host_id) a drifted name silently
// unhomes every fiber armed under the old one: the daemon sees a host it
// isn't, dispatches nothing, and reports nothing wrong. So the OS hostname is
// consulted once per machine and then retired: normalized (trimmed,
// lowercased, truncated at the first ".") and seeded into the host file,
// which every later resolve reads instead. Seeding is best-effort — a
// read-only home, or a machine with no ~/.shuttle at all, still resolves, just
// without the durability.
//
// Deliberately no daemon round-trip: the daemon shells this CLI while its
// Poller waits on the subprocess, so asking the daemon would be re-entrant.
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

// normalizeHostname reduces a raw OS hostname to its canonical short form:
// trimmed, lowercased, and cut at the first "." so "Studio-Air.home" and
// "studio-air" are the same machine.
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

// seedOwnHost makes this machine's identity durable, for `felt shuttle host
// seed` (which `bin/shuttle install-agent` runs before it starts the daemon it
// supervises). An identity already in the host file always wins: it may be a
// name someone chose, and re-deciding it would rename the machine out from
// under every fiber homed to it. Otherwise the resolved identity — $SHUTTLE_HOST,
// else the normalized OS hostname — is written, and seeded reports that.
//
// It differs from the implicit seeding in resolveOwnHost in two deliberate
// ways, both because installing a daemon is an explicit act of setting up
// shuttle's own state: it creates the file's directory, and it persists
// $SHUTTLE_HOST, so a daemon installed from a shell exporting it and a CLI
// shell without the export still name the machine alike.
func seedOwnHost() (id string, source hostSource, seeded bool, err error) {
	if h, ok := hostConfigFileValue(); ok {
		return h, hostSourceFile, false, nil
	}
	id, source, err = resolveOwnHostSourced("")
	if err != nil {
		return "", "", false, err
	}
	path := hostConfigFilePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", "", false, fmt.Errorf("create %s: %w", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(id+"\n"), 0o644); err != nil {
		return "", "", false, fmt.Errorf("write %s: %w", path, err)
	}
	return id, source, true, nil
}

// hostConfigFilePath is the canonical per-host identity file: SHUTTLE_HOST_FILE
// if set, else ~/.shuttle/host. The daemon asks `felt shuttle host --json`
// rather than reading it, so this is its only reader.
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
// This is the tier resolveOwnHost seeds on first fallback, so after one
// resolve on a fresh machine it is the tier that answers.
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
// no/invalid shuttle block, or a host-less block, falls through to a normal
// local write rather than hard-blocking — the guard closes the known
// mirror-write footgun, it is not a gate on every edit.
//
// An UNRESOLVABLE own-host identity is different and fails loud (returns the
// wrapped resolveOwnHost error) rather than falling through. Resolution is
// pure local state (env var, host file, os.Hostname), so a failure means those
// are ALL absent/empty — something genuinely broken. Silently permitting the
// write in that state is how a wrong-host mirror-write would happen
// invisibly; failing loud surfaces it instead.
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
	if owner == own {
		return nil
	}
	return ownerMismatchError{fiber: fiber, owner: owner, own: own, source: source}
}
