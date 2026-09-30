package shuttlecli

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/cailmdaley/felt/internal/shuttle"
)

// This file is the Go half of the host-local state contract: where the hook
// stream and the commit ledger live, when they may be written, and how the
// stream is bounded. It sits beside shuttle_stores.go as a "mirror the Elixir
// resolver in Go" module — the daemon reads these files
// (daemon/lib/shuttle/event_stream.ex, daemon/lib/shuttle/commit_ledger.ex), `shuttle hook event` and
// `shuttle hook commit` write them, and the two sides must never disagree about the paths.

const (
	// eventsDefaultMaxBytes bounds the live stream. On rollover the file is
	// renamed to <path>.1 (replacing any previous .1) and a fresh one starts.
	// Shuttle.EventStream recognizes the rename by the live path's inode
	// moving, reads the renamed file's last bytes, and continues from the new
	// file's start, so a rollover costs no reader anything it depends on.
	eventsDefaultMaxBytes = 64 << 20
	eventsRotatedSuffix   = ".1"
	// eventsLockSuffix names the sidecar file writers flock around a rotation.
	eventsLockSuffix = ".lock"
)

// shuttleStatePath resolves one host-local state file the way the Elixir side
// resolves it — an explicit env var, else the data directory, else ~/.shuttle:
//
//	$<envVar> → <shuttle.DataDir()>/<leaf>
//
// explicit reports whether the env var named the path — an explicit path is
// explicit intent, so it also overrides the write gate below. The path is ""
// when the data directory cannot be resolved (no home to expand against).
func shuttleStatePath(envVar, leaf string) (path string, explicit bool) {
	if v := strings.TrimSpace(os.Getenv(envVar)); v != "" {
		return v, true
	}
	dir, err := shuttle.DataDir()
	if err != nil {
		return "", false
	}
	return filepath.Join(dir, leaf), false
}

// eventsFilePath mirrors Shuttle.EventStream.default_events_file/0 exactly.
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
	if path == "" {
		return "", false
	}
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
func appendEventLine(path, line string) error {
	if info, err := os.Stat(path); err == nil && info.Size() >= eventsMaxBytes() {
		rotateEvents(path)
	}
	return appendLine(path, line)
}

// rotateEvents renames a full stream to <path>.1, once, however many hooks
// found it full at the same moment. Each takes an exclusive flock on a sidecar
// lock file and re-checks the size under it: the first renames, and the rest
// find a fresh file below the threshold and leave it alone. Without the lock
// a second rename would move that fresh file over .1, discarding the full
// history it had just replaced.
//
// Only a writer that saw the threshold crossed takes the lock, so the common
// append stays lock-free. The wait for the lock is bounded, because this runs
// inside a hook the agent harness blocks on: if the lock cannot be taken in
// time the rotation is skipped and the next append tries again; the stream
// runs a line over, never loses one.
func rotateEvents(path string) {
	unlock, ok := lockEventsRotation(path + eventsLockSuffix)
	if !ok {
		return
	}
	defer unlock()

	if info, err := os.Stat(path); err == nil && info.Size() >= eventsMaxBytes() {
		_ = os.Rename(path, path+eventsRotatedSuffix)
	}
}

// appendLine appends one line, creating the file if it does not exist.
//
// One O_APPEND write() per line, no locking: appends to a regular file are
// atomic against other appenders on both Darwin and Linux as long as the write
// is a single call, which is why hook_event.go bounds the line size before
// getting here.
func appendLine(path, line string) error {
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(line)
	return err
}
