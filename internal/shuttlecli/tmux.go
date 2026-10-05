package shuttlecli

import (
	"fmt"
	"regexp"
	"strings"
)

// tmux session naming + management for shuttle's worker-facing verbs (pause
// kills a live worker; attach/session-name address one). A worker's session is
// always <leaf>-<uid>-shuttle, the same scheme as the daemon's
// Shuttle.Dispatcher.session_name/2 and Shuttle.ULID.from_tmux/1, so the CLI
// recognizes the sessions the daemon launches. The daemon owns the launch; the
// CLI only recognizes and kills.

// fiberLeaf extracts the human-readable leaf (last path component) of a fiber id,
// e.g. "my-task" from "project/tasks/my-task". Keeps tmux/kitty titles legible
// when truncated.
func fiberLeaf(fiberID string) string {
	fiberID = strings.TrimRight(fiberID, "/")
	if fiberID == "" {
		return ""
	}
	if idx := strings.LastIndexByte(fiberID, '/'); idx >= 0 {
		return fiberID[idx+1:]
	}
	return fiberID
}

// shuttleTmuxSessionName is a worker's tmux session name: <leaf>-<uid>-shuttle.
// The uid (the fiber's intrinsic ULID) makes it collision-free and rename-safe —
// two fibers sharing a leaf do not collide, and renaming a fiber leaves the
// running worker's session addressable. A fiber whose uid is missing or is not
// a ULID has no session name (""): the daemon refuses to dispatch it.
func shuttleTmuxSessionName(fiberID, uid string) string {
	if !isSessionULID(uid) {
		return ""
	}
	return fiberLeaf(fiberID) + "-" + uid + "-shuttle"
}

// errFiberWithoutUID is the operator-facing error for a fiber that cannot have a
// worker session because it carries no intrinsic id.
func errFiberWithoutUID(fiberID string) error {
	return fmt.Errorf("fiber %s has no intrinsic ULID id, so it has no worker session name — run `felt backfill-ids` or add an `id:` (ULID) to its frontmatter", fiberID)
}

// tmuxHasSession and tmuxKillSession back app.tmuxSessionExists and
// app.killTmuxSession. The `=` prefix tells tmux to match the session name
// exactly (not as a pattern).
func (a *app) tmuxHasSession(sessionName string) bool {
	return a.env.Command("tmux", "has-session", "-t", "="+sessionName).Run() == nil
}

func (a *app) tmuxKillSession(session string) error {
	return a.env.Command("tmux", "kill-session", "-t", session).Run()
}

// shuttleSessionULID matches the uid a worker session name embeds:
// <leaf>-<ULID>-shuttle, Crockford base32 (no I, L, O, U).
var shuttleSessionULID = regexp.MustCompile(`-([0-9A-HJKMNP-TV-Z]{26})-shuttle$`)

// sessionULID is the uid shape a worker session can carry — the daemon's
// Shuttle.ULID.valid?/1, character for character.
var sessionULID = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{26}$`)

func isSessionULID(uid string) bool { return sessionULID.MatchString(uid) }

// fiberUIDFromTmuxSession returns the fiber uid embedded in a worker session
// name, or "" when the name is not a shuttle worker's.
func fiberUIDFromTmuxSession(sessionName string) string {
	if m := shuttleSessionULID.FindStringSubmatch(sessionName); m != nil {
		return m[1]
	}
	return ""
}

// isShuttleTmuxSessionName reports whether a tmux session name belongs to a
// shuttle worker: one that parses as <leaf>-<ULID>-shuttle.
func isShuttleTmuxSessionName(sessionName string) bool {
	return fiberUIDFromTmuxSession(sessionName) != ""
}

// tmuxLiveWorkerSessions returns the set of live shuttle worker session names —
// the running side of status/ps (app.liveTmuxSessions). An absent or empty
// server yields the empty set (status still renders, every row idle).
func (a *app) tmuxLiveWorkerSessions() map[string]bool {
	out, err := a.env.Command("tmux", "ls", "-F", "#{session_name}").Output()
	if err != nil {
		return map[string]bool{}
	}
	result := map[string]bool{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if isShuttleTmuxSessionName(line) {
			result[line] = true
		}
	}
	return result
}
