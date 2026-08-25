package cmd

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// This file is the Go half of the host-local state contract: where the hook
// stream and the commit ledger live, when they may be written, and how the
// stream is bounded. It sits beside shuttle_host.go and shuttle_stores.go as
// the third "mirror the Elixir resolver in Go" module — the daemon reads these
// files (lib/shuttle/waiting_tracker.ex, lib/shuttle/sent_files.ex,
// lib/shuttle/commit_ledger.ex), `felt hook event` and `felt hook commit`
// write them, and the two sides must never disagree about the paths.

const (
	// eventsDefaultMaxBytes bounds the live stream. On rollover the file is
	// renamed to <path>.1 (replacing any previous .1) and a fresh one starts.
	// WaitingTracker self-heals — it resets its tail offset when the file
	// shrinks — and SentFiles caps at the 50 most recent sends, so a rollover
	// costs nothing either reader depends on.
	eventsDefaultMaxBytes = 64 << 20
	eventsRotatedSuffix   = ".1"

	// sessionsDefaultMaxBytes mirrors Shuttle.SessionLedger's @max_bytes: one
	// line per session moment, not one per hook event.
	sessionsDefaultMaxBytes = 8 << 20
)

// shuttleStatePath resolves one host-local state file the way the Elixir side
// resolves it — an explicit env var, else the data directory, else ~/.shuttle:
//
//	$<envVar> → $SHUTTLE_DATA_DIR/<leaf> → ~/.shuttle/<leaf>
//
// explicit reports whether the env var named the path — an explicit path is
// explicit intent, so it also overrides the write gate below.
//
// Deliberately NO tilde expansion, unlike hostConfigFilePath: the Elixir
// resolvers do not expand either, and a literal `~/x` resolved the same
// (wrong) way by both sides is still one path. Diverging here would be worse
// than the odd directory.
func shuttleStatePath(envVar, leaf string) (path string, explicit bool) {
	if v := strings.TrimSpace(os.Getenv(envVar)); v != "" {
		return v, true
	}
	dir := strings.TrimSpace(os.Getenv("SHUTTLE_DATA_DIR"))
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil || strings.TrimSpace(home) == "" {
			// Matches the Elixir side's `System.user_home!() || "/root"`.
			home = "/root"
		}
		dir = filepath.Join(home, ".shuttle")
	}
	return filepath.Join(dir, leaf), false
}

// eventsFilePath mirrors Shuttle.WaitingTracker.default_events_file/0 exactly.
func eventsFilePath() (path string, explicit bool) {
	return shuttleStatePath("SHUTTLE_EVENTS_FILE", "events.jsonl")
}

// commitsFilePath mirrors Shuttle.CommitLedger.default_path/0 exactly — the
// same resolver as the event stream, one leaf over.
func commitsFilePath() (path string, explicit bool) {
	return shuttleStatePath("SHUTTLE_COMMITS_FILE", "commits.jsonl")
}

// shuttleSink applies the write gate to a resolved state path.
//
// The gate is the daemon's own state directory: write only when the file's
// parent already exists, and never create it. That directory is created by
// bootstrap.sh (and by every daemon that has ever run here), so a shuttle host
// is enabled with no configuration — while someone who installed felt for
// fibers alone gets one os.Stat, no file, and no surprise directory.
//
// An explicit path (SHUTTLE_EVENTS_FILE, SHUTTLE_COMMITS_FILE) is explicit
// intent: it bypasses the gate and creates its parent.
func shuttleSink(path string, explicit bool) (string, bool) {
	dir := filepath.Dir(path)
	if explicit {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return "", false
		}
		return path, true
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return "", false
	}
	return path, true
}

// eventsSink resolves the stream path and decides whether this host wants one.
// SHUTTLE_EVENTS=off is the kill switch for a host that has ~/.shuttle but
// wants no stream; it names the event stream and scopes to it.
func eventsSink() (string, bool) {
	if strings.EqualFold(strings.TrimSpace(os.Getenv("SHUTTLE_EVENTS")), "off") {
		return "", false
	}
	return shuttleSink(eventsFilePath())
}

// sessionsFilePath mirrors Shuttle.SessionLedger.default_path/0 exactly. The
// daemon writes the dispatch/claim/resume lines there; `felt shuttle handoff`
// writes the one moment only the exiting worker knows, its clean exit.
func sessionsFilePath() (path string, explicit bool) {
	return shuttleStatePath("SHUTTLE_SESSIONS_FILE", "sessions.jsonl")
}

// sessionsSink resolves the session ledger path under the same gate as the
// commit ledger: the daemon's state directory is the only switch.
func sessionsSink() (string, bool) {
	return shuttleSink(sessionsFilePath())
}

// commitsSink resolves the commit ledger path under the same gate. The state
// directory is the only switch here: the ledger has no stream to silence, and
// a host without ~/.shuttle acquires no file.
func commitsSink() (string, bool) {
	return shuttleSink(commitsFilePath())
}

// eventsMaxBytes is the rollover threshold, overridable by
// SHUTTLE_EVENTS_MAX_BYTES (bytes). A non-numeric or non-positive value falls
// back to the default rather than disabling the bound.
func eventsMaxBytes() int64 {
	if v := strings.TrimSpace(os.Getenv("SHUTTLE_EVENTS_MAX_BYTES")); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			return n
		}
	}
	return eventsDefaultMaxBytes
}

// appendEventLine rotates if needed, then appends one line.
//
// One O_APPEND write() per line, no locking: appends to a regular file are
// atomic against other appenders on both Darwin and Linux as long as the write
// is a single call, which is why hook_event.go bounds the line size before
// getting here.
func appendEventLine(path, line string) error {
	return appendBoundedLine(path, line, eventsMaxBytes())
}

// appendSessionLedgerLine appends one pairing to ~/.shuttle/sessions.jsonl,
// bounded the way Shuttle.SessionLedger bounds it.
func appendSessionLedgerLine(path, line string) error {
	return appendBoundedLine(path, line, sessionsDefaultMaxBytes)
}

func appendBoundedLine(path, line string, maxBytes int64) error {
	if info, err := os.Stat(path); err == nil && info.Size() >= maxBytes {
		// Best-effort: if the rename loses a race with another hook process,
		// the loser just appends to whichever file now holds the name.
		_ = os.Rename(path, path+eventsRotatedSuffix)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(line)
	return err
}
