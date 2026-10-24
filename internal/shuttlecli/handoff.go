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
		Use:   "handoff [fiber]",
		Short: "Stamp the clean-exit handoff signal for a worker",
		Long: `Stamps shuttle.runtime.handed_off_at = now into the fiber's frontmatter — the
signal that tells the daemon this worker exited CLEANLY, so the next dispatch
starts fresh (and reads the rewritten '## Status' block) instead of resuming a
dead transcript.

A worker calls this as its FINAL action, after rewriting the constitution's
'## Status' block: it stamps the field and then ends its own tmux session — so
the exit is one command, no separate 'kill $PPID'. For its own fiber the file
stamped is the resolved path when the tmux session's fiber UID matches, so
renames during a run are safe. Without an argument the current native session's
local ledger binding, or the current tmux pane's fiber UID, identifies the fiber.
SHUTTLE_FIBER_PATH is a fallback only without native or worker-pane evidence.
An explicit different fiber stamps that fiber and leaves the caller running.` + workerExitIdentityHelp,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			query := ""
			if len(args) > 0 {
				query = args[0]
			}
			path, self, err := a.resolveHandoffPath(query)
			if err != nil {
				return err
			}
			at, err := stampHandedOff(path, a.successorAgentKnown)
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

// isOwnFiber compares the target against current worker identity, never against
// a dispatch path contradicted by native-session or live-pane evidence.
func (a *app) isOwnFiber(f *felt.Felt) bool {
	own, err := a.currentWorkerFiber()
	return err == nil && own.UID == f.UID && a.samePath(own.Path, f.Path)
}

// resolveHandoffPath infers an omitted target and honors an explicit target.
// Lookup failure never substitutes the caller's ambient dispatch path.
func (a *app) resolveHandoffPath(fiber string) (string, bool, error) {
	if fiber == "" {
		f, err := a.currentWorkerFiber()
		if err != nil {
			return "", false, err
		}
		return f.Path, true, nil
	}
	f, _, err := a.shuttleResolveFiber(fiber, false)
	if err != nil {
		return "", false, err
	}
	if a.isOwnFiber(f) {
		return f.Path, true, nil
	}
	// An explicit target is never replaced with ambient worker identity.
	// Preserve manual handoff outside an identified worker.
	session, _ := a.tmuxCurrentSession()
	_, native := a.harnessSessionFromEnv()
	manual := native == "" && fiberUIDFromTmuxSession(session) == "" && a.env.Getenv("SHUTTLE_FIBER_PATH") == ""
	return f.Path, manual, nil
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

// endOwnTmuxSession tears down the tmux session this process is running in — the
// worker's <leaf>-<UID>-shuttle session. Exit verbs call it after their durable
// document write or successful daemon route. Best-effort and a no-op outside tmux (e.g.
// a manual/test invocation), so it never kills a stray shell: it asks tmux for the
// session of its own pane ($TMUX_PANE) and kills exactly that.
func (a *app) endOwnTmuxSession() {
	session, err := a.tmuxCurrentSession()
	if err != nil || session == "" {
		return
	}
	if _, native := a.harnessSessionFromEnv(); native != "" {
		own, err := a.currentWorkerFiber()
		if err != nil || fiberUIDFromTmuxSession(session) != own.UID {
			return
		}
	}
	// This kills our own pane mid-call; the field is already durably on disk (the
	// rename completed before we got here), so nothing is lost.
	_ = a.env.Command("tmux", "kill-session", "-t", session).Run()
}

// idFromPath derives a cosmetic fiber id from a .md path (the leaf stem). The id
// is not persisted (Felt.ID is yaml:"-"); Parse needs only a label.
func idFromPath(path string) string {
	return strings.TrimSuffix(filepath.Base(path), felt.FileExt)
}
