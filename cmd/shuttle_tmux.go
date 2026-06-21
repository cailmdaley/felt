package cmd

import (
	"os/exec"
	"strings"
)

// tmux session naming + management for the felt CLI's worker-facing verbs (pause
// kills a live worker; attach/session-name address one). The names MUST match the
// daemon's own scheme — a uid-keyed canonical form with a legacy leaf-only
// fallback — so the CLI recognizes a session the daemon launched. Ported from
// shuttle-ctl (pkg/schema/fiber.go); the daemon owns the launch, the CLI only
// recognizes and kills.

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

// legacyTmuxSessionName is the pre-uid session form (<leaf>-shuttle), kept for
// dual-recognition of workers launched before the uid-keyed cutover.
func legacyTmuxSessionName(fiberID string) string {
	return fiberLeaf(fiberID) + "-shuttle"
}

// shuttleTmuxSessionName is the canonical worker session name: <leaf>-<uid>-shuttle.
// The uid (intrinsic ULID) makes it collision-free and rename-safe — two fibers
// sharing a leaf no longer collide, and renaming a fiber leaves the running
// worker's session addressable. An empty uid falls back to the legacy form.
func shuttleTmuxSessionName(fiberID, uid string) string {
	if uid == "" {
		return legacyTmuxSessionName(fiberID)
	}
	return fiberLeaf(fiberID) + "-" + uid + "-shuttle"
}

// shuttleTmuxSessionNames returns both the canonical (uid-keyed) and legacy
// session names so recognition matches a live worker regardless of which scheme
// launched it. With a uid: [canonical, legacy]; without: [legacy].
func shuttleTmuxSessionNames(fiberID, uid string) []string {
	if uid == "" {
		return []string{legacyTmuxSessionName(fiberID)}
	}
	return []string{shuttleTmuxSessionName(fiberID, uid), legacyTmuxSessionName(fiberID)}
}

// tmuxSessionExists / killTmuxSession are func vars so tests can stub tmux
// without shelling out to a real server. The `=` prefix tells tmux to match the
// session name exactly (not as a pattern).
var tmuxSessionExists = func(sessionName string) bool {
	return exec.Command("tmux", "has-session", "-t", "="+sessionName).Run() == nil
}

var killTmuxSession = func(session string) error {
	return exec.Command("tmux", "kill-session", "-t", session).Run()
}
