package cmd

import (
	"encoding/json"
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
	Long: `Stamps shuttle.runtime.handed_off_at = now into the fiber's frontmatter — the
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
		path, self, fiberID, err := resolveHandoffPath(args[0])
		if err != nil {
			return err
		}
		at, f, err := stampHandedOff(path)
		if err != nil {
			return err
		}
		// The frontmatter stamp only ever describes the LATEST run; the ledger
		// line is what lets a later reader tell which of a fiber's sessions
		// ended cleanly and which died mid-thought.
		recordHandoffPairing(f, fiberID, at)
		fmt.Printf("handed off: %s (handed_off_at=%s)\n", path, at)
		// Final act — but ONLY when handing off our own fiber: end our own tmux
		// session (no-op outside tmux). The field is already durably on disk, so
		// the kill loses nothing. A worker stamping a DIFFERENT fiber (e.g. a
		// dead sibling worker's) stays alive.
		if self {
			endOwnTmuxSession()
		}
		return nil
	},
}

func init() {
	shuttleCmd.AddCommand(shuttleHandoffCmd)
}

// resolveHandoffPath returns the fiber `.md` the worker should stamp, plus
// whether that fiber is the worker's OWN (which gates the tmux self-kill). The
// daemon exports SHUTTLE_FIBER_PATH at dispatch — the path it already resolved —
// so a worker handing off its own fiber writes the same file the daemon reads on
// the next poll, with no store resolution and no ambiguity.
//
// The explicit <fiber> argument beats the ambient env: when the argument names a
// DIFFERENT fiber than SHUTTLE_FIBER_PATH (a worker stamping a sibling — e.g.
// cleaning up after a dead worker on another card), the argument wins and the
// caller is NOT treated as exiting. The env path is used when the argument
// resolves to the same fiber (the normal self-handoff, where the env path is the
// authoritative one) or when argument resolution fails outright (cwd/store
// ambiguity — the pre-existing fallback). Paths are compared through
// EvalSymlinks because loom stores reach fibers through symlinked .felt trees.
//
// Belt against fuzzy resolution: felt's resolver slug/suffix-matches, so an
// argument can land on a fiber the caller didn't mean (the dispatch prompt's
// global-id fallback is the realistic trigger). A DIFFERENT-fiber result is
// honored only when the argument names it exactly (id or UID); a fuzzy match
// that disagrees with the env is treated as ambiguity and the env wins — the
// pre-fix behavior, which at worst stamps the caller's own fiber.
func resolveHandoffPath(fiber string) (string, bool, string, error) {
	envPath := os.Getenv("SHUTTLE_FIBER_PATH")
	f, _, err := shuttleResolveFiber(fiber, false)
	if err != nil {
		if envPath != "" {
			return envPath, true, "", nil
		}
		return "", false, "", fmt.Errorf("resolving fiber %q (SHUTTLE_FIBER_PATH unset): %w", fiber, err)
	}
	if envPath == "" {
		return f.Path, true, f.ID, nil
	}
	if samePath(envPath, f.Path) {
		return envPath, true, f.ID, nil
	}
	if fiber == f.ID || fiber == f.UID {
		return f.Path, false, f.ID, nil
	}
	return envPath, true, "", nil
}

// samePath reports whether two paths name the same file, absolutizing and
// resolving symlinks so a store path and its loom-symlinked alias compare
// equal. Falls back to string equality when resolution fails (e.g. a
// not-yet-existing path) — a bias toward "different", which errs on the safe
// side: stamping the named file without the self-kill, never a false
// clean-exit.
func samePath(a, b string) bool {
	ra, errA := canonicalPath(a)
	rb, errB := canonicalPath(b)
	if errA != nil || errB != nil {
		return a == b
	}
	return ra == rb
}

func canonicalPath(p string) (string, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(abs)
}

// stampHandedOff sets shuttle.runtime.handed_off_at = <now RFC3339 UTC> in the
// fiber's frontmatter, surgically (SetShuttleRuntimeField touches only that one
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
// F4: acquires path's cross-process advisory lock (internal/felt/lock.go)
// BEFORE the read, and holds it through the write. A worker's handoff and a
// daemon-shelled `mark-runtime` (the dispatch stamp, or a conclude re-arm) can
// race the same fiber file; without the lock, whichever writes last silently
// drops the other's field. The lock forces them to serialize instead.
func stampHandedOff(path string) (string, *felt.Felt, error) {
	unlock, err := felt.LockFiberFile(path)
	if err != nil {
		return "", nil, err
	}
	defer unlock()

	content, err := os.ReadFile(path)
	if err != nil {
		return "", nil, err
	}
	f, err := felt.Parse(idFromPath(path), content)
	if err != nil {
		return "", nil, err
	}
	at := time.Now().UTC().Format(time.RFC3339Nano)
	if err := f.SetShuttleRuntimeField("handed_off_at", at); err != nil {
		return "", nil, err
	}
	data, err := f.Marshal()
	if err != nil {
		return "", nil, err
	}
	if err := atomicWriteFile(path, data); err != nil {
		return "", nil, err
	}
	return at, f, nil
}

// recordHandoffPairing appends a `handoff` line to this host's session ledger,
// naming the session that just exited cleanly. The daemon writes the ledger's
// dispatch/claim/resume lines; this is the fourth moment, and only the exiting
// worker is in a position to write it.
//
// Best-effort throughout, exactly like the daemon's own ledger writes: a
// missing session UUID (a fiber handed off before it was ever dispatched), no
// ~/.shuttle, or a failed append all cost a provenance row, never the handoff
// itself — the durable clean-exit signal is already on disk in the frontmatter.
func recordHandoffPairing(f *felt.Felt, fiberID, at string) {
	if f == nil {
		return
	}
	session := handoffSessionUUID(f)
	if session == "" {
		return
	}
	if fiberID == "" {
		// The store-relative id is the ledger's own address shape; the parsed
		// file only knows its leaf stem, which would read as a different fiber.
		fiberID = f.ID
	}
	path, ok := sessionsSink()
	if !ok {
		return
	}
	host, err := resolveOwnHost("")
	if err != nil {
		host = ""
	}
	stamp, err := time.Parse(time.RFC3339Nano, at)
	if err != nil {
		stamp = time.Now().UTC()
	}
	line, err := json.Marshal(map[string]any{
		"fiber":   fiberID,
		"uid":     f.UID,
		"session": session,
		"host":    host,
		"at":      stamp.UnixMilli(),
		"kind":    "handoff",
	})
	if err != nil {
		return
	}
	_ = appendSessionLedgerLine(path, string(line)+"\n")
}

// handoffSessionUUID reads the daemon-stamped session UUID the ledger line
// names. It is deliberately not modeled by shuttle.Block (runtime keys ride
// through as raw node content), so it is read the way the rest of cmd reads
// them. Harness and tmux are left out rather than guessed: the dispatch line
// already carries them, and the reader folds this line onto that row by
// session UUID.
func handoffSessionUUID(f *felt.Felt) string {
	if f.ExtraFields == nil {
		return ""
	}
	node, ok := f.ExtraFields["shuttle"]
	if !ok || node == nil {
		return ""
	}
	var block map[string]any
	if err := node.Decode(&block); err != nil {
		return ""
	}
	session, _ := block["session_uuid"].(string)
	if runtime, ok := block["runtime"].(map[string]any); ok {
		if value, ok := runtime["session_uuid"].(string); ok && strings.TrimSpace(value) != "" {
			session = value
		}
	}
	return strings.TrimSpace(session)
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
