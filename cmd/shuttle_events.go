package cmd

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// This file is the Go half of the event-stream contract: where the host-local
// hook stream lives, when it may be written, and how it is bounded. It sits
// beside shuttle_host.go and shuttle_stores.go as the third "mirror the Elixir
// resolver in Go" module — the daemon reads this file
// (lib/shuttle/waiting_tracker.ex, lib/shuttle/sent_files.ex), `felt hook
// event` writes it, and the two must never disagree about the path.

const (
	// eventsDefaultMaxBytes bounds the live stream. On rollover the file is
	// renamed to <path>.1 (replacing any previous .1) and a fresh one starts.
	// WaitingTracker self-heals — it resets its tail offset when the file
	// shrinks — and SentFiles caps at the 50 most recent sends, so a rollover
	// costs nothing either reader depends on.
	eventsDefaultMaxBytes = 64 << 20
	eventsRotatedSuffix   = ".1"
)

// eventsFilePath mirrors Shuttle.WaitingTracker.default_events_file/0 exactly:
//
//	$SHUTTLE_EVENTS_FILE → $SHUTTLE_DATA_DIR/events.jsonl → ~/.shuttle/events.jsonl
//
// explicit reports whether SHUTTLE_EVENTS_FILE named the path — an explicit
// path is explicit intent, so it also overrides the write gate below.
//
// Deliberately NO tilde expansion, unlike hostConfigFilePath: the Elixir
// resolver does not expand either, and a literal `~/x` resolved the same
// (wrong) way by both sides is still one path. Diverging here would be worse
// than the odd directory.
func eventsFilePath() (path string, explicit bool) {
	if v := strings.TrimSpace(os.Getenv("SHUTTLE_EVENTS_FILE")); v != "" {
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
	return filepath.Join(dir, "events.jsonl"), false
}

// eventsSink resolves the stream path and decides whether this host wants one.
//
// The gate is the daemon's own state directory: write only when the events
// file's parent already exists, and never create it. That directory is created
// by bootstrap.sh (and by every daemon that has ever run here), so a Shuttle
// host is enabled with no configuration — while someone who installed felt for
// fibers alone gets one os.Stat, no file, and no surprise directory.
//
// Two overrides sit on either side of it: SHUTTLE_EVENTS=off is the kill
// switch for a host that has ~/.shuttle but wants no stream, and an explicit
// SHUTTLE_EVENTS_FILE bypasses the gate and creates its parent.
func eventsSink() (string, bool) {
	if strings.EqualFold(strings.TrimSpace(os.Getenv("SHUTTLE_EVENTS")), "off") {
		return "", false
	}
	path, explicit := eventsFilePath()
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
	if info, err := os.Stat(path); err == nil && info.Size() >= eventsMaxBytes() {
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
