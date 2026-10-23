package shuttlecli

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

func (a *app) shuttleHandoffCmd() *cobra.Command {
	shuttleHandoffCmd := &cobra.Command{
		Use:   "handoff <fiber>",
		Short: "Stamp the clean-exit handoff signal for a worker",
		Long: `Stamps shuttle.runtime.handed_off_at = now into the fiber's frontmatter — the
signal that tells the daemon this worker exited CLEANLY, so the next dispatch
starts fresh (and reads the rewritten '## Status' block) instead of resuming a
dead transcript.

A worker calls this as its FINAL action, after rewriting the constitution's
'## Status' block: it stamps the field and then ends its own tmux session — so
the exit is one command, no separate 'kill $PPID'. The caller's own fiber is
the one whose runtime names the caller's conversation (CLAUDE_CODE_SESSION_ID,
PI_SESSION_ID); a worker that claimed another fiber, as this host's session
ledger records, exits only on that fiber's handoff. Without a conversation
match, the uid of its tmux session's launch, else SHUTTLE_FIBER_PATH,
identifies it. The
fiber lock is held from the read through the exit, so a claim cannot land in
between. An exact id or UID naming a different fiber stamps that fiber and
leaves the caller's session running. Outside any worker — no conversation
id, no SHUTTLE_FIBER_PATH, a tmux session not launched by Shuttle — the
<fiber> argument is resolved and the current tmux session (if any) still
ends.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			path, self, err := a.resolveHandoffPath(args[0])
			if err != nil {
				return err
			}
			unlock, err := felt.LockFiberFile(path)
			if err != nil {
				return err
			}
			defer unlock()
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			f, err := felt.Parse(idFromPath(path), data)
			if err != nil {
				return err
			}
			f.Path = path
			// A claim that landed first moved the caller to another fiber; it
			// stays alive.
			if _, id := a.harnessSessionFromEnv(); id != "" && a.claimedAway(f, id) {
				self = false
			}
			at, err := stampHandedOffLocked(path, a.successorAgentKnown)
			if err != nil {
				return err
			}
			fmt.Fprintf(a.env.Stdout, "handed off: %s (handed_off_at=%s)\n", path, at)
			// Final act — but ONLY when handing off our own fiber: end our own tmux
			// session (no-op outside tmux). The field is already durably on disk, so
			// the kill loses nothing. A worker stamping a DIFFERENT fiber (e.g. a
			// dead sibling worker's) stays alive.
			if self {
				a.endOwnTmuxSession()
			}
			return nil
		},
	}
	return shuttleHandoffCmd
}

// isOwnFiber reports whether the caller is f's live worker. A worker that has
// claimed another fiber is not its earlier fiber's worker any more, whatever
// its tmux session is called or its dispatch environment says. Otherwise the
// caller's conversation id decides when f's runtime names it; else the uid its
// tmux session was launched with, then the dispatch path. Without any of
// these, ownership is unknown and an exit verb leaves the caller alive.
func (a *app) isOwnFiber(f *felt.Felt) bool {
	if _, id := a.harnessSessionFromEnv(); id != "" {
		if a.claimedAway(f, id) {
			return false
		}
		if runtimeScalar(f, "session_uuid") == id {
			return true
		}
	}
	session, _ := a.tmuxCurrentSession()
	uid := fiberUIDFromTmuxSession(session)
	if uid != "" && uid == f.UID {
		return true
	}
	if envPath := a.env.Getenv("SHUTTLE_FIBER_PATH"); envPath != "" {
		return a.samePath(envPath, f.Path)
	}
	return false
}

// claimedAway reports that this host's session ledger last paired
// conversation id with a fiber other than f: a claim moved its worker there.
func (a *app) claimedAway(f *felt.Felt, id string) bool {
	host, err := a.resolveOwnHost("")
	if err != nil || f.UID == "" {
		return false
	}
	paired := ""
	for _, row := range a.localMessageLedger() {
		if row.Session == id && row.Host == host && row.Kind != "superseded_by_claim" && row.UID != "" {
			paired = row.UID
		}
	}
	return paired != "" && paired != f.UID
}

// runtimeScalar is the scalar shuttle.runtime.<key> of f, or "".
func runtimeScalar(f *felt.Felt, key string) string {
	runtime := felt.MappingValueNode(f.ExtraFields["shuttle"], "runtime")
	if node := felt.MappingValueNode(runtime, key); node != nil {
		return node.Value
	}
	return ""
}

// resolveHandoffPath returns the stamp path and whether the caller is exiting.
// The caller's own fiber selects the resolved path, including after a rename.
// Otherwise the dispatch path wins on lookup failure or fuzzy ambiguity; an
// exact id or UID naming a different fiber always selects that fiber without
// ending the caller's session.
func (a *app) resolveHandoffPath(fiber string) (string, bool, error) {
	envPath := a.env.Getenv("SHUTTLE_FIBER_PATH")
	f, _, err := a.shuttleResolveFiber(fiber, false)
	if err != nil {
		if envPath != "" {
			return envPath, true, nil
		}
		return "", false, fmt.Errorf("resolving fiber %q (SHUTTLE_FIBER_PATH unset): %w", fiber, err)
	}
	if a.isOwnFiber(f) {
		if envPath != "" && a.samePath(envPath, f.Path) {
			return envPath, true, nil
		}
		return f.Path, true, nil
	}
	if envPath == "" {
		// Manual handoff ends the current session; a recognized worker naming
		// another fiber must stay alive even without its dispatch environment.
		session, _ := a.tmuxCurrentSession()
		_, id := a.harnessSessionFromEnv()
		return f.Path, fiberUIDFromTmuxSession(session) == "" && id == "", nil
	}
	if fiber == f.ID || fiber == f.UID {
		return f.Path, false, nil
	}
	return envPath, true, nil
}

// samePath reports whether two paths name the same file, absolutizing and
// resolving symlinks so a store path and its loom-symlinked alias compare
// equal. Falls back to string equality when resolution fails (e.g. a
// not-yet-existing path) — a bias toward "different", which errs on the safe
// side: stamping the named file without the self-kill, never a false
// clean-exit.
func (a *app) samePath(left, right string) bool {
	ra, errA := a.canonicalPath(left)
	rb, errB := a.canonicalPath(right)
	if errA != nil || errB != nil {
		return left == right
	}
	return ra == rb
}

func (a *app) canonicalPath(p string) (string, error) {
	abs, err := a.env.Abs(p)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(abs)
}

// stampHandedOff sets shuttle.runtime.handed_off_at = <now RFC3339 UTC> in the
// fiber's frontmatter, surgically (shuttle.SetRuntimeField touches only that one
// nested key, so the daemon-written session_uuid / dispatched_at ride through),
// and writes atomically. This is the clean-exit
// signal: the daemon compares handed_off_at against dispatched_at to decide
// fresh-vs-resume at the next dispatch. RFC3339Nano with a trailing Z (UTC) — the
// Elixir reader parses it via DateTime.from_iso8601, and the comparison is on the
// wire value, so sub-second precision is exact.
//
// Operates on the file at `path` directly (read -> Parse -> stamp -> Marshal ->
// atomic rename) rather than through Storage, because SHUTTLE_FIBER_PATH may name
// a fiber in a store other than the worker's cwd; the path is unambiguous.
//
// It acquires path's cross-process advisory lock (internal/felt/lock.go)
// BEFORE the read, and holds it through the write. A worker's handoff and a
// daemon-shelled `mark-runtime` (the dispatch stamp, or a conclude re-arm) can
// race the same fiber file; without the lock, whichever writes last silently
// drops the other's field. The lock forces them to serialize instead.
// successorAgentKnown refuses a handoff whose block names an agent the
// registry does not know: the successor would launch with it, and the daemon
// cannot resolve it. A registry that cannot load does not hold up the exit.
func (a *app) successorAgentKnown(f *felt.Felt) error {
	block, ok, err := shuttle.BlockOf(f)
	if err != nil || !ok || block.Agent == "" {
		return nil
	}
	reg, err := shuttle.LoadAgentRegistry(a.env)
	if err != nil {
		fmt.Fprintf(a.env.Stderr, "warning: agent registry unavailable, %s's agent unchecked: %v\n", f.ID, err)
		return nil
	}
	if err := reg.NotAnAgent(block.Agent); err != nil {
		return fmt.Errorf("cannot hand off %s: its successor's agent %w; name one with `shuttle set-agent %s <agent>` and hand off again", f.ID, err, f.ID)
	}
	return nil
}

// stampHandedOff stamps handed_off_at once check accepts the fiber as read
// under its lock; a nil check accepts every fiber.
func stampHandedOff(path string, check func(*felt.Felt) error) (string, error) {
	unlock, err := felt.LockFiberFile(path)
	if err != nil {
		return "", err
	}
	defer unlock()
	return stampHandedOffLocked(path, check)
}

// stampHandedOffLocked requires the caller to hold path's fiber lock through
// the write and any self-exit that follows it.
func stampHandedOffLocked(path string, check func(*felt.Felt) error) (string, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	f, err := felt.Parse(idFromPath(path), content)
	if err != nil {
		return "", err
	}
	if check != nil {
		if err := check(f); err != nil {
			return "", err
		}
	}
	at := time.Now().UTC().Format(time.RFC3339Nano)
	if err := shuttle.SetRuntimeField(f, "handed_off_at", at); err != nil {
		return "", err
	}
	data, err := f.Marshal()
	if err != nil {
		return "", err
	}
	if err := felt.WriteFiberFile(path, data); err != nil {
		return "", err
	}
	return at, nil
}

// endOwnTmuxSession ends the worker this process runs in by killing its own
// tmux pane ($TMUX_PANE) — a daemon launch's whole session, which holds that one
// pane, and only the pane of a human's session a claimed harness runs in. Exit
// verbs call it after their durable document write or successful daemon route.
// Best-effort and a no-op outside tmux (e.g. a manual/test invocation).
func (a *app) endOwnTmuxSession() {
	if a.env.Getenv("TMUX") == "" {
		return
	}
	pane := strings.TrimSpace(a.env.Getenv("TMUX_PANE"))
	if pane == "" {
		return
	}
	// This kills our own pane mid-call; the field is already durably on disk (the
	// rename completed before we got here), so nothing is lost.
	_ = a.env.Command("tmux", "kill-pane", "-t", pane).Run()
}

// idFromPath derives a cosmetic fiber id from a .md path (the leaf stem). The id
// is not persisted (Felt.ID is yaml:"-"); Parse needs only a label.
func idFromPath(path string) string {
	return strings.TrimSuffix(filepath.Base(path), felt.FileExt)
}
