package cmd

import (
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

// The lifecycle write verbs — pause/resume/reopen/close/set-outcome/accept/
// set-model/set-agent/reshape/uninstall. A fiber's lifecycle is felt-native:
// status (the sole dispatch gate) is f.Status, the human verdict is the
// top-level `tempered` ExtraField, closed-at is f.ClosedAt; only the config
// verbs (set-model/set-agent/reshape) touch the shuttle: block, and they do it
// surgically (SetShuttleField / SetShuttleNodeField) so the daemon-owned runtime
// keys ride through untouched. Every write passes the ownership guard. felt is
// the one writer of every lifecycle transition: resume and accept hop through
// the owning daemon, which runs the same verb with --local inside its Poller
// (serialized with its state changes, its document cache refreshed after), and
// write here
// with --local or when no connection to the daemon can be made.

// resolveOwnedShuttleFiber is the common preamble for a lifecycle or config
// write verb: a full read (body preserved for the re-serialize), a required
// shuttle: block, and the ownership guard. Returns the fiber, its storage, the
// typed block, and an unlock func the caller MUST defer immediately (before any
// other return) so the fiber's cross-process lock (see internal/felt/lock.go)
// is held for the caller's entire read-modify-write cycle and released
// exactly once no matter which return path fires.
//
// missingBlockHint is appended parenthetically to the no-block error: the
// config verbs point at the create verb that would install one, the lifecycle
// verbs pass "" and get the bare message.
//
// Locks BEFORE re-reading, not before the initial shuttleResolveFiber lookup:
// resolving `query` to a fiber id can itself require scanning/reading multiple
// candidates, so it runs unlocked. Once the target id is known, this acquires
// the lock and re-reads fresh from disk — discarding the unlocked read — so the
// mutation callers build on the RunE below is guaranteed current as of lock
// acquisition, not raced against whatever wrote in the gap between the unlocked
// lookup and the lock. That reload is the "acquire lock -> read" half of the
// acquire/read/modify/write/release cycle this function starts on behalf of
// every lifecycle verb.
//
// The returned ref carries where the fiber turned out to live: a shuttle verb
// crosses the view boundary like rm and edit do, and every verb appends
// ref.location() to its headline so a cross-store write is never silent.
func resolveOwnedShuttleFiber(query, missingBlockHint string) (*felt.Felt, *felt.Storage, *shuttle.Block, fiberRef, func() error, error) {
	f, st, ref, err := shuttleResolveFiberRef(query, true)
	if err != nil {
		return nil, nil, nil, fiberRef{}, nil, err
	}
	f, unlock, err := lockAndReloadFiber(st, f)
	if err != nil {
		return nil, nil, nil, fiberRef{}, nil, err
	}
	block, ok, err := f.ShuttleBlock()
	if err != nil {
		unlock()
		return nil, nil, nil, fiberRef{}, nil, err
	}
	if !ok {
		unlock()
		if missingBlockHint == "" {
			return nil, nil, nil, fiberRef{}, nil, fmt.Errorf("fiber %s has no shuttle: block", query)
		}
		return nil, nil, nil, fiberRef{}, nil, fmt.Errorf("fiber %s has no shuttle: block (%s)", query, missingBlockHint)
	}
	if err := ensureOwnedHere(f, query); err != nil {
		unlock()
		return nil, nil, nil, fiberRef{}, nil, err
	}
	return f, st, block, ref, unlock, nil
}

// lockAndReloadFiber acquires f.ID's cross-process advisory lock
// (internal/felt/lock.go) and re-reads it fresh from disk, so a resolver that
// already did an unlocked read to match a query doesn't hand its caller a copy
// that a concurrent writer could have raced between that read and lock
// acquisition. On any error the lock (if acquired) is released before
// returning, so a failed reload never leaks a held lock.
func lockAndReloadFiber(st *felt.Storage, f *felt.Felt) (*felt.Felt, func() error, error) {
	unlock, err := st.LockFiber(f.ID)
	if err != nil {
		return nil, nil, fmt.Errorf("locking fiber %s: %w", f.ID, err)
	}
	fresh, err := st.Read(f.ID)
	if err != nil {
		unlock()
		return nil, nil, fmt.Errorf("re-reading fiber %s under lock: %w", f.ID, err)
	}
	return fresh, unlock, nil
}

// ---- pause -----------------------------------------------------------------

var pauseNoKill bool

var pauseCmd = &cobra.Command{
	Use:   "pause <fiber>",
	Short: "Pause dispatch, kill any live worker, and park a fiber in drafts",
	Long: `Sets the felt-native status to "open" (the draft / paused state — the daemon
never dispatches an open fiber) while preserving the schedule, then kills the
worker tmux session if one is running. Clears tempered / closed-at so the card
lands in Drafts rather than Awaiting review.

Use --no-kill to stop scheduling only and let a live worker finish naturally.
status is the fiber's only dispatch switch; there is no enabled flag.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		f, st, _, ref, unlock, err := resolveOwnedShuttleFiber(args[0], "")
		if err != nil {
			return err
		}
		defer unlock()

		statusBefore := f.Status
		if err := unclose(f, felt.StatusOpen); err != nil {
			return err
		}
		if err := st.Write(f); err != nil {
			return fmt.Errorf("writing fiber: %w", err)
		}
		fmt.Printf("paused %s%s (status: open; schedule preserved)\n", args[0], ref.location())
		if statusBefore != felt.StatusOpen {
			fmt.Printf("  status: %s → open\n", shuttleNonEmpty(statusBefore, "(missing)"))
		}
		if statusBefore == felt.StatusClosed {
			fmt.Println("  cleared: tempered, closed-at")
		}
		if pauseNoKill {
			fmt.Println("  worker: left running (--no-kill)")
			return nil
		}

		session, _ := liveWorkerSession(f)
		if session == "" {
			fmt.Printf("  worker: no live session %s\n", shuttleTmuxSessionName(f.ID, f.UID))
			return nil
		}
		if err := killTmuxSession(session); err != nil {
			return fmt.Errorf("killing tmux session %q: %w", session, err)
		}
		fmt.Printf("  worker: killed %s\n", session)
		return nil
	},
}

// ---- resume ----------------------------------------------------------------

var (
	resumeProjectDir string
	resumeLocal      bool
)

var resumeCmd = &cobra.Command{
	Use:   "resume <fiber>",
	Short: "Arm a paused fiber (status: active)",
	Long: `Sets the felt-native status to "active" — the fiber's dispatch switch — so
the owning daemon dispatches it on its next poll (after a daemon restart, once
the boot quarantine is released).

For a standing role awaiting review (status: closed + untempered), resume re-arms
it and concludes the run it reviewed (shuttle.runtime.handed_off_at = now), so
the role runs at its schedule's next tick. That write routes through the owning
daemon, which applies it with --local inside its Poller, serialized with the
daemon's own state changes; a poll read in flight sees the old document or the
new one, written in one atomic step. --local, or a daemon that cannot be
reached, writes the document here. A daemon that takes
the request but does not answer in time is reported, not bypassed: the
transition may still apply there. A draft (status: open) is armed
straight to active. Every other closed fiber — a oneshot or pinned role, or any
accepted or discarded close — is refused; use 'felt shuttle reopen' to requeue
it.

Arming needs what an armed install needs: an agent the registry resolves and a
project_dir. A draft installed without one is refused; --project-dir sets it
(an existing directory on this machine, stored absolute) and arms in one step.`,
	Example: `  felt shuttle resume analysis/scratch
  felt shuttle resume analysis/scratch --project-dir "$PWD"   # a draft installed without one`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if !resumeLocal && !cmd.Flags().Changed("project-dir") {
			if routed, err := routeLifecycle("resume", args[0], standingAwaiting); routed {
				return err
			}
		}
		f, st, block, ref, unlock, err := resolveOwnedShuttleFiber(args[0], "")
		if err != nil {
			return err
		}
		defer unlock()
		if err := setProjectDirFlag(cmd, resumeProjectDir, f, block); err != nil {
			return err
		}
		if err := checkArmable(args[0], "resume", block); err != nil {
			return err
		}

		if standingAwaiting(f, block) {
			if err := rearmStanding(f); err != nil {
				return err
			}
			if err := st.Write(f); err != nil {
				return fmt.Errorf("writing fiber: %w", err)
			}
			fmt.Printf("resumed %s%s (standing role re-armed; next run on the schedule's next tick)\n", args[0], ref.location())
			return nil
		}

		statusBefore := f.Status
		if statusBefore == felt.StatusClosed {
			return fmt.Errorf("fiber %s has status: closed; use 'felt shuttle reopen %s' to clear verdict fields and requeue it", args[0], args[0])
		}
		f.Status = felt.StatusActive
		if err := st.Write(f); err != nil {
			return fmt.Errorf("writing fiber: %w", err)
		}
		fmt.Printf("resumed %s%s (status: active)\n", args[0], ref.location())
		if statusBefore != felt.StatusActive {
			if statusBefore == "" {
				fmt.Println("  status: active (set; was missing)")
			} else {
				fmt.Printf("  status: %s → active\n", statusBefore)
			}
		}
		return nil
	},
}

// standingAwaiting reports whether f is a standing role awaiting review:
// status: closed with no verdict (tempered unset).
func standingAwaiting(f *felt.Felt, block *shuttle.Block) bool {
	return block.Kind == "standing" && f.Status == felt.StatusClosed && readTempered(f) == nil
}

// rearmStanding re-arms a standing role (status: active, verdict and
// closed-at cleared) and concludes its run by stamping
// shuttle.runtime.handed_off_at = now in the same document write. A human
// accept or resume ends the run the way a worker handoff does: the poller's
// repeat-firing guard is prev_due > last_serviced, where last_serviced is the
// latest of dispatched_at / handed_off_at / created_at, so the fresh stamp
// rests the role until its next occurrence instead of re-firing the one that
// just ran. Status and stamp land in one write, so no reader sees the role
// armed without the stamp. UTC, in the wire format stampHandedOff uses.
func rearmStanding(f *felt.Felt) error {
	if err := unclose(f, felt.StatusActive); err != nil {
		return err
	}
	if err := f.SetShuttleRuntimeField("handed_off_at", time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		return fmt.Errorf("stamping handed_off_at: %w", err)
	}
	return nil
}

// routeLifecycle hands verb to the owning daemon when the fiber qualifies and
// reports whether the daemon took it. The daemon runs the same verb with
// --local serialized with its Poller's state changes, so its document cache
// sees the write at once. The lookup takes no fiber lock — the daemon's writer
// needs it. routed is false when the fiber does not qualify (or cannot be
// read) or no connection to the daemon could be made; the caller then writes
// locally, where every refusal is reported. A daemon refusal, an owner-check
// failure, or a request the daemon received but did not answer is routed, with
// its error — the last because the transition may still apply there.
func routeLifecycle(verb, query string, qualifies func(*felt.Felt, *shuttle.Block) bool) (routed bool, err error) {
	f, _, _, err := shuttleResolveFiberRef(query, true)
	if err != nil {
		return false, nil
	}
	block, ok, err := f.ShuttleBlock()
	if err != nil || !ok || !qualifies(f, block) || ensureOwnedHere(f, query) != nil {
		return false, nil
	}
	output, err := postLifecycle(verb, f.ID)
	if err == nil {
		fmt.Print(output)
		return true, nil
	}
	if isLifecycleTransportError(err) {
		return false, nil
	}
	var unanswered *daemonUnansweredError
	if errors.As(err, &unanswered) {
		return true, fmt.Errorf("%s %s: the daemon at %s %s (%v); the %s may still apply — check `felt show %s` before retrying", verb, f.ID, unanswered.url, unanswered.what(), unanswered.err, verb, f.ID)
	}
	return true, err
}

// checkArmable is the arming gate: every verb that makes a fiber dispatchable
// (resume, reopen, accept, edit -s active) holds the block to what an armed
// install requires. It needs a project_dir — without one the daemon still
// dispatches the fiber but starts its worker in the felt store instead of the
// checkout the work belongs to, the fallback an armed install never takes —
// and an agent the registry resolves, so a retired id (kept on closed fibers
// as history — content edits never check it) is refused with the registry's
// list rather than failing later inside the daemon. verb is the lifecycle
// verb that arms this fiber from where it stands (armVerb), which the refusal
// names with the --project-dir that satisfies it.
func checkArmable(fiberID, verb string, block *shuttle.Block) error {
	if strings.TrimSpace(block.ProjectDir) == "" {
		return fmt.Errorf("cannot arm %s: its shuttle: block has no project_dir (set it as you arm it: felt shuttle %s %s --project-dir <dir>)", fiberID, verb, fiberID)
	}
	reg, err := shuttle.LoadAgentRegistry()
	if err != nil {
		return err
	}
	// Delegate to the same resolution shuttle.Validate performs (named agent,
	// or registry default when unnamed, together with effort/chrome), so a
	// bare block on a host with no configured default fails open the same
	// way install/create already tolerate it — no separate default-resolution
	// logic here that could diverge from Validate's.
	for _, e := range shuttle.Validate(block, reg) {
		if e.Field == "agent" {
			return fmt.Errorf("cannot arm: %s (felt shuttle set-agent to pick a current one)", e.Message)
		}
	}
	return nil
}

// armVerb names the lifecycle verb that arms a fiber standing at status:
// reopen for a closed fiber, except a standing role awaiting review, which
// resume re-arms through its daemon (concluding the run); resume otherwise.
func armVerb(status string, f *felt.Felt, block *shuttle.Block) string {
	if status == felt.StatusClosed && !(block.Kind == "standing" && readTempered(f) == nil) {
		return "reopen"
	}
	return "resume"
}

// setProjectDirFlag applies an arming verb's --project-dir, when given, to
// f's shuttle: block and to block, so the arming gate reads the block as it
// will be written.
func setProjectDirFlag(cmd *cobra.Command, raw string, f *felt.Felt, block *shuttle.Block) error {
	if !cmd.Flags().Changed("project-dir") {
		return nil
	}
	projectDir, err := resolveProjectDirFlag(raw)
	if err != nil {
		return err
	}
	if err := f.SetShuttleField("project_dir", projectDir); err != nil {
		return err
	}
	block.ProjectDir = projectDir
	return nil
}

// ---- close -----------------------------------------------------------------

var closeTempered string

var closeCmd = &cobra.Command{
	Use:   "close <fiber>",
	Short: "Close a shuttle-managed fiber and optionally set the human verdict",
	Long: `Sets status: closed, sets/clears tempered, and stamps closed-at when the
field is missing. Use:

  felt shuttle close <fiber>                   # awaiting review (tempered cleared)
  felt shuttle close <fiber> --tempered=true   # human-accepted
  felt shuttle close <fiber> --tempered=false  # discarded

The shuttle block stays installed; closed fibers are ignored by the daemon
until reopen or accept moves them (resume also re-arms a standing role
awaiting review).`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		f, st, _, ref, unlock, err := resolveOwnedShuttleFiber(args[0], "")
		if err != nil {
			return err
		}
		defer unlock()

		tempered, err := parseOptionalBool(closeTempered)
		if err != nil {
			return fmt.Errorf("parsing --tempered: %w", err)
		}

		f.Status = felt.StatusClosed
		if err := setTempered(f, tempered); err != nil {
			return err
		}
		setClosedAtIfMissing(f)
		if err := st.Write(f); err != nil {
			return fmt.Errorf("writing fiber: %w", err)
		}

		fmt.Printf("closed %s%s\n", args[0], ref.location())
		switch {
		case tempered == nil:
			fmt.Println("  tempered: cleared (awaiting review)")
		case *tempered:
			fmt.Println("  tempered: true")
		default:
			fmt.Println("  tempered: false")
		}
		return nil
	},
}

// ---- reopen ----------------------------------------------------------------

var (
	reopenAsDraft    bool
	reopenProjectDir string
)

var reopenCmd = &cobra.Command{
	Use:   "reopen <fiber>",
	Short: "Requeue a closed or reviewed fiber back into active work",
	Long: `Sets status = active and clears tempered / closed-at so a closed card
re-enters the in-flight loop. status is the fiber's only dispatch switch.

Arming needs what an armed install needs: an agent the registry resolves and a
project_dir. A block without one is refused; --project-dir sets it (an
existing directory on this machine, stored absolute) in the same step.

With --as-draft, sets status = open instead: the card reopens as a PAUSED DRAFT
— visible on the board, never auto-dispatched.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		f, st, block, ref, unlock, err := resolveOwnedShuttleFiber(args[0], "")
		if err != nil {
			return err
		}
		defer unlock()

		if err := setProjectDirFlag(cmd, reopenProjectDir, f, block); err != nil {
			return err
		}
		status := felt.StatusActive
		if reopenAsDraft {
			status = felt.StatusOpen
		} else if err := checkArmable(args[0], "reopen", block); err != nil {
			return err
		}
		statusBefore := f.Status
		if err := unclose(f, status); err != nil {
			return err
		}
		if err := st.Write(f); err != nil {
			return fmt.Errorf("writing fiber: %w", err)
		}

		fmt.Printf("reopened %s%s (status: %s)\n", args[0], ref.location(), status)
		if statusBefore == "" {
			fmt.Printf("  status: %s (set; was missing)\n", status)
		} else if statusBefore != status {
			fmt.Printf("  status: %s → %s\n", statusBefore, status)
		}
		fmt.Println("  cleared: tempered, closed-at")
		return nil
	},
}

// ---- set-outcome -----------------------------------------------------------

var setOutcomeValue string

var setOutcomeCmd = &cobra.Command{
	Use:   "set-outcome <fiber>",
	Short: "Set the outcome field on a shuttle-managed fiber",
	Long: `Updates the felt-native outcome: field while preserving the existing
shuttle: block. Use --outcome for single-line values, or pipe multi-line text
on stdin to preserve block-scalar output.

Examples:
  felt shuttle set-outcome <fiber> --outcome "Blocked: waiting on ADS token"
  printf 'First line\nSecond line\n' | felt shuttle set-outcome <fiber>`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		f, st, _, ref, unlock, err := resolveOwnedShuttleFiber(args[0], "")
		if err != nil {
			return err
		}
		defer unlock()

		outcome, err := resolveOutcomeValue(cmd, setOutcomeValue)
		if err != nil {
			return err
		}

		f.Outcome = outcome
		if err := st.Write(f); err != nil {
			return fmt.Errorf("writing fiber: %w", err)
		}

		fmt.Printf("set outcome for %s%s\n", args[0], ref.location())
		return nil
	},
}

// resolveOutcomeValue returns the --outcome flag when set, else reads the outcome
// from stdin (refusing an interactive terminal). Trailing newlines are trimmed.
func resolveOutcomeValue(cmd *cobra.Command, flagValue string) (string, error) {
	if cmd.Flags().Changed("outcome") {
		return flagValue, nil
	}

	in := cmd.InOrStdin()
	if file, ok := in.(*os.File); ok {
		if stat, err := file.Stat(); err == nil && (stat.Mode()&os.ModeCharDevice) != 0 {
			return "", fmt.Errorf("provide --outcome or pipe outcome text on stdin")
		}
	}

	data, err := io.ReadAll(in)
	if err != nil {
		return "", fmt.Errorf("reading outcome from stdin: %w", err)
	}
	return strings.TrimRight(string(data), "\r\n"), nil
}

// ---- accept ----------------------------------------------------------------

var acceptLocal bool

var acceptCmd = &cobra.Command{
	Use:   "accept <fiber>",
	Short: "Accept a completed standing or pinned run (re-arm / re-park)",
	Long: `Resolves the human verdict on an untempered role (status: closed, or
status: active while its run is still in flight), kind-aware:

  standing → re-arms it (status: active), clearing closed-at / tempered, and
             concludes the run (shuttle.runtime.handed_off_at = now) so the
             next dispatch is the schedule's next tick. Due-ness is recomputed
             by the daemon from the schedule (no stored next_due_at, no review
             block).
  pinned   → re-parks it back to the strip (status: open), clearing
             closed-at / tempered. A human Resume (force-dispatch) starts it
             again.

The outcome is kept: the last run's digest stays the card's headline until the
next run writes its own.

Routes to the owning daemon, which applies it with --local inside its Poller,
serialized with the daemon's own state changes; a poll read in flight sees the
old document or the new one, written in one atomic step. --local, or a daemon
that cannot be reached, writes the document here.
A daemon that takes the request but does not answer in time is reported, not
bypassed: the accept may still apply there.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if !acceptLocal {
			if routed, err := routeLifecycle("accept", args[0], perennialRole); routed {
				return err
			}
		}
		f, st, block, ref, unlock, err := resolveOwnedShuttleFiber(args[0], "")
		if err != nil {
			return err
		}
		defer unlock()
		if !perennialRole(f, block) {
			return fmt.Errorf("accept only applies to standing or pinned roles (fiber has kind=%s)", block.Kind)
		}
		// Acceptable: untempered, and closed (awaiting review) or still active —
		// the board's Temper gesture can land while the run is in flight, before
		// the exit writer closes it. Drafts and verdicts are refused.
		if readTempered(f) != nil || (f.Status != felt.StatusClosed && f.Status != felt.StatusActive) {
			return fmt.Errorf(
				"fiber %s is not acceptable (accept requires status active|closed + untempered; status=%q tempered=%v)",
				args[0], f.Status, readTempered(f))
		}

		// PINNED accept RE-PARKS the finished arc back to the strip (status: open,
		// verdict cleared) — the kind-aware other half of accept (standing re-arms
		// active, pinned re-parks open). No schedule, no recurrence to advance.
		if block.Kind == "pinned" {
			if err := unclose(f, felt.StatusOpen); err != nil {
				return err
			}
			if err := st.Write(f); err != nil {
				return fmt.Errorf("writing fiber: %w", err)
			}
			fmt.Printf("accepted pinned role %s%s (re-parked to the strip: status: open)\n", args[0], ref.location())
			return nil
		}

		if block.Schedule == nil {
			return fmt.Errorf("fiber %s has no schedule", args[0])
		}
		// Arming a closed role holds it to the armed-install gate; accepting a
		// role that is already active arms nothing.
		if f.Status != felt.StatusActive {
			if err := checkArmable(args[0], "resume", block); err != nil {
				return err
			}
		}
		computedNext, err := shuttle.NextOccurrence(block.Schedule, time.Now())
		if err != nil {
			return fmt.Errorf("computing next occurrence: %w", err)
		}
		if err := rearmStanding(f); err != nil {
			return err
		}
		if err := st.Write(f); err != nil {
			return fmt.Errorf("writing fiber: %w", err)
		}
		fmt.Printf("accepted run for %s%s (re-armed; next run on the schedule's next tick)\n  next due: %s\n",
			args[0], ref.location(), computedNext.Format(time.RFC3339))
		return nil
	},
}

// perennialRole reports whether block is a standing or pinned role — the kinds
// accept resolves a verdict on.
func perennialRole(_ *felt.Felt, block *shuttle.Block) bool {
	return block.Kind == "standing" || block.Kind == "pinned"
}

// ---- set-model -------------------------------------------------------------

var setModelCmd = &cobra.Command{
	Use:   "set-model <fiber> <agent>",
	Short: "Change only the dispatch agent for a fiber",
	Long: `Updates shuttle.agent to the given agent ID, validated against the agent
registry (together with the block's existing effort/chrome axes) before writing.
Effort, chrome and surface stay as they are — use set-agent to change them
with the agent; a block on surface: app can only move to another Codex agent
here. Daemon-owned runtime keys are preserved. This saves the next-launch
agent without starting or replacing a worker.`,
	Args: cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		reg, err := shuttle.LoadAgentRegistry()
		if err != nil {
			return fmt.Errorf("loading agent registry: %w", err)
		}
		f, st, block, ref, unlock, err := resolveOwnedShuttleFiber(args[0], "use 'felt shuttle repeat' to install first")
		if err != nil {
			return err
		}
		defer unlock()

		axes := agentAxes{agent: args[1], effort: block.Effort, chrome: block.Chrome, surface: block.Surface}
		if err := axes.write(f, reg); err != nil {
			return err
		}
		if err := st.Write(f); err != nil {
			return fmt.Errorf("writing fiber: %w", err)
		}

		fmt.Printf("set agent for %s%s → %s\n", args[0], ref.location(), args[1])
		return nil
	},
}

// ---- set-agent -------------------------------------------------------------

var (
	setAgentEffort  string
	setAgentChrome  bool
	setAgentSurface string
)

// setAgentCmd is the axis-aware mutation verb: it composes base agent × effort ×
// chrome in one validated write. set-model stays the narrow base-agent verb; this
// is the superset. Each axis is set surgically (a real !!bool for chrome, a
// delete for a cleared effort/agent) so the runtime keys are preserved.
var setAgentCmd = &cobra.Command{
	Use:   "set-agent <fiber> [agent]",
	Short: "Set the dispatch agent and/or axes (effort, chrome, surface) for a fiber",
	Long: `Composes a fiber's dispatch axes — base agent, effort, chrome, surface — and
writes them to the shuttle: block after validating the combination against the
agent registry's per-harness constraints. The base agent argument is optional:
omit it to mutate only the axes of the current agent; an omitted flag keeps
that axis as it is. Pass --effort "" to clear effort back to the harness
default, --chrome=false to drop chrome. --surface app is Codex-only: moving a
block on the app to another harness takes --surface cli in the same call.
Settings apply to the next launch; this command does not start, stop, resume,
or replace a worker.`,
	Args: cobra.RangeArgs(1, 2),
	RunE: func(cmd *cobra.Command, args []string) error {
		reg, err := shuttle.LoadAgentRegistry()
		if err != nil {
			return fmt.Errorf("loading agent registry: %w", err)
		}
		f, st, block, ref, unlock, err := resolveOwnedShuttleFiber(args[0], "use 'felt shuttle repeat' to install first")
		if err != nil {
			return err
		}
		defer unlock()

		agentID := block.Agent
		if len(args) == 2 {
			agentID = args[1]
		}
		effort := block.Effort
		if cmd.Flags().Changed("effort") {
			effort = setAgentEffort
		}
		chrome := block.Chrome
		if cmd.Flags().Changed("chrome") {
			chrome = setAgentChrome
		}
		surface := block.Surface
		if cmd.Flags().Changed("surface") {
			surface = setAgentSurface
		}

		axes := agentAxes{agent: agentID, effort: effort, chrome: chrome, surface: surface}
		if err := axes.write(f, reg); err != nil {
			return err
		}
		if err := st.Write(f); err != nil {
			return fmt.Errorf("writing fiber: %w", err)
		}

		fmt.Printf("set agent for %s%s → %s", args[0], ref.location(), shuttleNonEmpty(agentID, "(default)"))
		if effort != "" {
			fmt.Printf(" effort=%s", effort)
		}
		if chrome {
			fmt.Printf(" chrome")
		}
		fmt.Println()
		return nil
	},
}

// agentAxes is one composition of a block's dispatch axes: base agent (empty
// for the registry default), effort, chrome and surface.
type agentAxes struct {
	agent   string
	effort  string
	chrome  bool
	surface string
}

// write validates the composition against the registry and sets it on f's
// shuttle: block — surgically, so the daemon-owned runtime keys survive: a
// cleared agent or effort drops its key, chrome is a real bool or absent.
// set-model and set-agent both write through here, so neither can leave a
// block naming a surface its agent cannot run on.
func (a agentAxes) write(f *felt.Felt, reg *shuttle.AgentRegistry) error {
	name := a.agent
	if name == "" {
		if def, err := reg.Default(); err == nil {
			name = def.ID
		}
	}
	base, _, err := reg.Resolve(name, a.effort, a.chrome)
	if err != nil {
		return err
	}
	if a.surface != "" && a.surface != "cli" && a.surface != "app" {
		return fmt.Errorf("surface must be cli or app, got %q", a.surface)
	}
	if a.surface == "app" && base.CLI != "codex" {
		return fmt.Errorf("surface app is supported only by Codex agents, got %q (to move this block off the app: felt shuttle set-agent <fiber> %s --surface cli)", base.ID, name)
	}

	if err := f.SetShuttleNodeField("agent", axisValue(a.agent)); err != nil {
		return err
	}
	if err := f.SetShuttleNodeField("effort", axisValue(a.effort)); err != nil {
		return err
	}
	var chrome any
	if a.chrome {
		chrome = true
	}
	if err := f.SetShuttleNodeField("chrome", chrome); err != nil {
		return err
	}
	return f.SetShuttleNodeField("surface", axisValue(a.surface))
}

// axisValue maps a string axis to a typed-set value: an empty string deletes the
// key (omitempty), a non-empty string is written as-is.
func axisValue(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// ---- reshape ---------------------------------------------------------------

var (
	reshapeSchedule string
	reshapeTZ       string
)

// reshape is the surgical setter for `kind`. The create verbs rebuild the
// whole block (re-resolving project_dir and host) and refuse a closed fiber,
// so they cannot re-shape a role in Awaiting review; here kind (and, for a
// standing role, the schedule) is set exactly the way set-model sets agent:
// f.SetShuttleField on the live node, so the daemon-owned runtime: keys ride
// through and nothing else on the block or the fiber is disturbed.
//
// Like every other config verb, it NEVER touches felt status / closed_at /
// tempered / outcome: a role sitting in Awaiting review is reshaped in place and
// stays exactly there. Also like every other config verb, there is no
// live/dispatched guard — set-model on a running worker has always been legal,
// and reshape deliberately matches that.
var reshapeCmd = &cobra.Command{
	Use:   "reshape <fiber> [kind]",
	Short: "Change a role's kind (and standing schedule) in place",
	Long: `Surgically rewrites the shuttle: block's kind — and, for a standing role, its
schedule — leaving every other key (agent, host, project_dir, the daemon-owned
runtime keys) and the fiber's whole lifecycle (status, tempered, closed-at,
outcome) untouched.

  felt shuttle reshape <fiber> oneshot                          # standing → oneshot (schedule dropped)
  felt shuttle reshape <fiber> standing --schedule "0 9 * * 1-5" --tz Europe/Paris
  felt shuttle reshape <fiber> --schedule "0 7 * * *"           # keep the kind, re-time it

The kind argument is optional: omit it to keep the current kind (a schedule-only
edit). A standing target needs a schedule — from --schedule, or echoed from the
block being reshaped. A oneshot or pinned target DROPS the schedule key, so a
schedule-less kind never carries a stale recurrence; passing --schedule or --tz
with one is an error.

Requires an existing shuttle: block — use install / repeat / pin to create one.
This is a config edit, not a lifecycle move: it never changes status, so use
pause / resume / close / reopen for that.`,
	Args: cobra.RangeArgs(1, 2),
	RunE: func(cmd *cobra.Command, args []string) error {
		reg, err := shuttle.LoadAgentRegistry()
		if err != nil {
			return fmt.Errorf("loading agent registry: %w", err)
		}
		f, st, block, ref, unlock, err := resolveOwnedShuttleFiber(args[0],
			"use 'felt shuttle install' / 'repeat' / 'pin' to create one first")
		if err != nil {
			return err
		}
		defer unlock()

		kind := block.Kind
		if len(args) == 2 {
			kind = args[1]
		}
		if !slices.Contains(shuttle.ValidKinds, kind) {
			return fmt.Errorf("kind must be one of %v, got %q", shuttle.ValidKinds, kind)
		}

		// Build the candidate block off the decoded one and validate the WHOLE
		// composition before any write, so a rejected reshape leaves the block on
		// disk exactly as it was.
		candidate := *block
		candidate.Kind = kind
		var next time.Time
		if kind == "standing" {
			expr := reshapeSchedule
			if !cmd.Flags().Changed("schedule") && block.Schedule != nil {
				expr = block.Schedule.Expr
			}
			if strings.TrimSpace(expr) == "" {
				return fmt.Errorf("--schedule is required to reshape %s to a standing role (the block being reshaped has none to echo)", args[0])
			}
			tz := reshapeTZ
			if tz == "" && block.Schedule != nil {
				tz = block.Schedule.TZ
			}
			if tz == "" {
				tz = "UTC"
			}
			candidate.Schedule = &shuttle.Schedule{Expr: expr, TZ: tz}
		} else {
			if cmd.Flags().Changed("schedule") {
				return fmt.Errorf("--schedule is only meaningful for kind=standing (target kind is %s)", kind)
			}
			if cmd.Flags().Changed("tz") {
				return fmt.Errorf("--tz is only meaningful for kind=standing (target kind is %s)", kind)
			}
			candidate.Schedule = nil
		}

		if errs := shuttle.Validate(&candidate, reg); len(errs) > 0 {
			return printShuttleValidationErrors(errs)
		}
		if candidate.Schedule != nil {
			next, err = shuttle.NextOccurrence(candidate.Schedule, time.Now())
			if err != nil {
				return fmt.Errorf("computing next occurrence: %w", err)
			}
		}

		// Surgical writes: kind as a scalar, schedule as a typed sub-mapping — or
		// deleted (nil) for a schedule-less kind.
		if err := f.SetShuttleField("kind", kind); err != nil {
			return err
		}
		if candidate.Schedule != nil {
			if err := f.SetShuttleNodeField("schedule", candidate.Schedule); err != nil {
				return err
			}
		} else if err := f.SetShuttleNodeField("schedule", nil); err != nil {
			return err
		}
		if err := st.Write(f); err != nil {
			return fmt.Errorf("writing fiber: %w", err)
		}

		if block.Kind == kind {
			fmt.Printf("reshaped %s%s (kind: %s, unchanged)\n", args[0], ref.location(), kind)
		} else {
			fmt.Printf("reshaped %s%s (kind: %s → %s)\n", args[0], ref.location(), shuttleNonEmpty(block.Kind, "(unset)"), kind)
		}
		if candidate.Schedule != nil {
			fmt.Printf("  schedule: %s (%s)\n", candidate.Schedule.Expr, candidate.Schedule.TZ)
			fmt.Printf("  next due: %s\n", next.Format(time.RFC3339))
		} else if block.Schedule != nil {
			fmt.Printf("  schedule: dropped (kind=%s has no recurrence)\n", kind)
		}
		printPreservedStatus(f.Status)
		fmt.Println("  verdict fields (tempered, closed-at, outcome): untouched")
		return nil
	},
}

// printPreservedStatus reports that a reshape left status exactly as it found
// it: a closed fiber stays in Awaiting review with its verdict fields intact, a
// draft stays parked, an armed role stays armed. Lifecycle verbs
// (pause/resume/close/reopen) are the only way to move status; changing standing
// → oneshot is not one of them.
func printPreservedStatus(status string) {
	shown := status
	if shown == "" {
		shown = "(missing)"
	}
	note := "unchanged — a reshape changes shape, not lifecycle"
	if status == felt.StatusClosed {
		note = "unchanged — reshape does not requeue; `felt shuttle reopen` does"
	}
	fmt.Printf("  status: %s (%s)\n", shown, note)
}

// ---- uninstall -------------------------------------------------------------

var uninstallShuttleCmd = &cobra.Command{
	Use:   "uninstall <fiber>",
	Short: "Remove the shuttle: block from a fiber",
	Long: `Removes the shuttle: block entirely. The fiber is left in place; the
daemon will no longer dispatch it. The fiber's status and tags are not changed,
and a live worker is left running.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		f, st, ref, err := shuttleResolveFiberRef(args[0], true)
		if err != nil {
			return err
		}
		if !f.HasShuttleFacet() {
			fmt.Printf("fiber %s has no shuttle: block (nothing to do)\n", args[0])
			return nil
		}
		f, unlock, err := lockAndReloadFiber(st, f)
		if err != nil {
			return err
		}
		defer unlock()
		if err := ensureOwnedHere(f, args[0]); err != nil {
			return err
		}
		if err := f.SetExtraField(felt.ShuttleFacetKey, nil); err != nil {
			return fmt.Errorf("removing shuttle block: %w", err)
		}
		if err := st.Write(f); err != nil {
			return fmt.Errorf("removing shuttle block: %w", err)
		}
		fmt.Printf("uninstalled %s%s (shuttle: block removed)\n", args[0], ref.location())
		return nil
	},
}

func init() {
	resumeCmd.Flags().StringVar(&resumeProjectDir, "project-dir", "", "Set the worker cwd before arming (required when the block has none); writes here, without the daemon hop")
	resumeCmd.Flags().BoolVar(&resumeLocal, "local", false, "Write the document here instead of routing through the owning daemon")
	pauseCmd.Flags().BoolVar(&pauseNoKill, "no-kill", false, "Only disable future dispatch; leave any live worker tmux session running")
	closeCmd.Flags().StringVar(&closeTempered, "tempered", "", "Set tempered verdict (true/false); omit to clear it for awaiting review")
	reopenCmd.Flags().BoolVar(&reopenAsDraft, "as-draft", false, "reopen to status: open (a paused draft, not auto-dispatched) instead of status: active")
	reopenCmd.Flags().StringVar(&reopenProjectDir, "project-dir", "", "Set the worker cwd as it reopens (required to arm when the block has none)")
	setOutcomeCmd.Flags().StringVar(&setOutcomeValue, "outcome", "", "Outcome text; omit to read from stdin")
	acceptCmd.Flags().BoolVar(&acceptLocal, "local", false, "Write the document here instead of routing through the owning daemon")
	setAgentCmd.Flags().StringVar(&setAgentEffort, "effort", "", `Effort level (harness-native token, e.g. low|medium|high|xhigh|max); "" clears; omit to preserve`)
	setAgentCmd.Flags().BoolVar(&setAgentChrome, "chrome", false, "Enable chrome (claude harness only); --chrome=false clears; omit to preserve")
	setAgentCmd.Flags().StringVar(&setAgentSurface, "surface", "", "Execution surface: cli or app (Codex only); omit to preserve")
	reshapeCmd.Flags().StringVarP(&reshapeSchedule, "schedule", "s", "", "Cron expression (5-field standard syntax); standing target only")
	reshapeCmd.Flags().StringVarP(&reshapeTZ, "tz", "z", "", "IANA timezone name (default: the block's existing tz, else UTC); standing target only")

	shuttleCmd.AddCommand(pauseCmd)
	shuttleCmd.AddCommand(resumeCmd)
	shuttleCmd.AddCommand(closeCmd)
	shuttleCmd.AddCommand(reopenCmd)
	shuttleCmd.AddCommand(setOutcomeCmd)
	shuttleCmd.AddCommand(acceptCmd)
	shuttleCmd.AddCommand(setModelCmd)
	shuttleCmd.AddCommand(setAgentCmd)
	shuttleCmd.AddCommand(reshapeCmd)
	shuttleCmd.AddCommand(uninstallShuttleCmd)
}
