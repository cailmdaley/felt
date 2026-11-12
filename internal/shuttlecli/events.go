package shuttlecli

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/cailmdaley/felt/internal/shuttle"
)

// This file is the writer's half of the host-local state contract: when the
// hook stream and the commit ledger may be written, and how the stream is
// bounded. shuttle.EventsFile and shuttle.CommitsFile name the files; the
// daemon reads them (daemon/lib/shuttle/event_stream.ex,
// daemon/lib/shuttle/commit_ledger.ex), and `shuttle hook event` and
// `shuttle hook commit` write them.

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

// shuttleSink applies the write gate to a resolved state path. An explicit
// path (the env var named it) also overrides the gate.
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
func (a *app) eventsSink() (string, bool) {
	if strings.EqualFold(strings.TrimSpace(a.env.Getenv("SHUTTLE_EVENTS")), "off") {
		return "", false
	}
	return shuttleSink(shuttle.EventsFile(a.env))
}

// commitsSink resolves the commit ledger path under the same gate. The state
// directory is the only switch here: the ledger has no stream to silence, and
// a host without ~/.shuttle acquires no file.
func (a *app) commitsSink() (string, bool) {
	return shuttleSink(shuttle.CommitsFile(a.env))
}

// eventsMaxBytes is the rollover threshold, overridable by
// SHUTTLE_EVENTS_MAX_BYTES (bytes). A non-numeric or non-positive value falls
// back to the default rather than disabling the bound.
func (a *app) eventsMaxBytes() int64 {
	if v := strings.TrimSpace(a.env.Getenv("SHUTTLE_EVENTS_MAX_BYTES")); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			return n
		}
	}
	return eventsDefaultMaxBytes
}

// appendEventLine serializes rotation and append against other writers. A
// line whose writer waits past eventsLockWait for the lock is dropped.
func (a *app) appendEventLine(path, line string) error {
	unlock, ok := lockEventsRotation(path+eventsLockSuffix, a.eventsLockWait)
	if !ok {
		return fmt.Errorf("event stream lock timed out")
	}
	defer unlock()
	if info, err := os.Stat(path); err == nil && info.Size() >= a.eventsMaxBytes() {
		_ = os.Rename(path, path+eventsRotatedSuffix)
	}
	return appendLine(path, line)
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
