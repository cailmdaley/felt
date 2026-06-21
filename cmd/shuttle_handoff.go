package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var shuttleHandoffCmd = &cobra.Command{
	Use:   "handoff <fiber>",
	Short: "Stamp the clean-exit handoff signal for a worker",
	Long: `Stamps shuttle.handed_off_at = now into the fiber's frontmatter — the
signal that tells the daemon this worker exited CLEANLY, so the next dispatch
starts fresh (and reads the rewritten '## Status' block) instead of resuming a
dead transcript.

A worker calls this as its FINAL action, after rewriting the constitution's
'## Status' block: it stamps the field and then ends its own tmux session — so
the exit is one command, no separate 'kill $PPID'. The target fiber is the file
at SHUTTLE_FIBER_PATH, which the daemon exports at dispatch (the path it already
resolved); outside a daemon-launched worker the <fiber> argument is resolved
instead.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		path, err := resolveHandoffPath(args[0])
		if err != nil {
			return err
		}
		at, err := stampHandedOff(path)
		if err != nil {
			return err
		}
		fmt.Printf("handed off: %s (handed_off_at=%s)\n", path, at)
		// Final act: end our own tmux session (no-op outside tmux). The field is
		// already durably on disk, so the kill loses nothing.
		endOwnTmuxSession()
		return nil
	},
}

func init() {
	shuttleCmd.AddCommand(shuttleHandoffCmd)
}

// resolveHandoffPath returns the fiber `.md` the worker should stamp. The daemon
// exports SHUTTLE_FIBER_PATH at dispatch — the path it already resolved — so the
// worker writes the same file the daemon reads on the next poll, with no store
// resolution and no ambiguity. Falls back to resolving the <fiber> argument (a
// manual/test invocation outside a daemon-launched worker).
func resolveHandoffPath(fiber string) (string, error) {
	if path := os.Getenv("SHUTTLE_FIBER_PATH"); path != "" {
		return path, nil
	}
	f, _, err := shuttleResolveFiber(fiber, false)
	if err != nil {
		return "", fmt.Errorf("resolving fiber %q (SHUTTLE_FIBER_PATH unset): %w", fiber, err)
	}
	return f.Path, nil
}

// stampHandedOff sets shuttle.handed_off_at = <now RFC3339 UTC> in the fiber's
// frontmatter, surgically (SetShuttleField preserves the daemon-written
// session_uuid / dispatched_at), and writes atomically. This is the clean-exit
// signal: the daemon compares handed_off_at against dispatched_at to decide
// fresh-vs-resume at the next dispatch. RFC3339Nano with a trailing Z (UTC) — the
// Elixir reader parses it via DateTime.from_iso8601, and the comparison is on the
// wire value, so sub-second precision is exact.
//
// Operates on the file at `path` directly (read -> Parse -> stamp -> Marshal ->
// atomic rename) rather than through Storage, because SHUTTLE_FIBER_PATH may name
// a fiber in a store other than the worker's cwd; the path is unambiguous.
func stampHandedOff(path string) (string, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	f, err := felt.Parse(idFromPath(path), content)
	if err != nil {
		return "", err
	}
	at := time.Now().UTC().Format(time.RFC3339Nano)
	if err := f.SetShuttleField("handed_off_at", at); err != nil {
		return "", err
	}
	data, err := f.Marshal()
	if err != nil {
		return "", err
	}
	if err := atomicWriteFile(path, data); err != nil {
		return "", err
	}
	return at, nil
}

// endOwnTmuxSession tears down the tmux session this process is running in — the
// worker's `shuttle-<id>` session. Folded into handoff so the worker's exit is ONE
// command (stamp the clean-exit field, then end the session) instead of a write
// followed by a separate `kill $PPID`. Best-effort and a no-op outside tmux (e.g.
// a manual/test invocation), so it never kills a stray shell: it asks tmux for the
// *current* session name and kills exactly that.
func endOwnTmuxSession() {
	if os.Getenv("TMUX") == "" {
		return
	}
	name, err := exec.Command("tmux", "display-message", "-p", "#S").Output()
	if err != nil {
		return
	}
	session := strings.TrimSpace(string(name))
	if session == "" {
		return
	}
	// This kills our own pane mid-call; the field is already durably on disk (the
	// rename completed before we got here), so nothing is lost.
	_ = exec.Command("tmux", "kill-session", "-t", session).Run()
}

// idFromPath derives a cosmetic fiber id from a .md path (the leaf stem). The id
// is not persisted (Felt.ID is yaml:"-"); Parse needs only a label.
func idFromPath(path string) string {
	return strings.TrimSuffix(filepath.Base(path), felt.FileExt)
}

// atomicWriteFile writes data to path via a temp file in the same directory and a
// rename, so a concurrent reader (the daemon's poll) never sees a truncated file.
// felt's own Storage.Write is a plain os.WriteFile; handoff earns atomicity because
// the worker exits immediately after and the daemon may poll mid-write.
func atomicWriteFile(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".shuttle-handoff-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}
