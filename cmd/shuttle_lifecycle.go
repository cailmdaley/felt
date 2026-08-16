package cmd

import (
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
// set-model/set-agent/uninstall — reimplemented on felt's own data model. A
// fiber's lifecycle is felt-native: status (the sole dispatch gate) is f.Status,
// the human verdict is the top-level `tempered` ExtraField, closed-at is
// f.ClosedAt; only set-model/set-agent touch the shuttle: block, and they do it
// surgically (SetShuttleField / SetShuttleNodeField) so the daemon-owned runtime
// keys ride through untouched. Every write passes the ownership guard. resume and
// accept take a soft hop through the daemon (atomic re-arm against its poll
// cycle) with a correct local-write fallback when it is down. Ported faithfully
// from shuttle-ctl's cmd/shuttle/lifecycle.go.

// resolveOwnedShuttleFiber is the common preamble for a lifecycle or config
// write verb: a full read (body preserved for the re-serialize), a required
// shuttle: block, and the ownership guard. Returns the fiber, its storage, the
// typed block, and an unlock func the caller MUST defer immediately (before any
// other return) so the fiber's cross-process lock (see internal/felt/lock.go,
// F4) is held for the caller's entire read-modify-write cycle and released
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
// C1: previously took an explicit own-host override for the daemon-shelled
// mark-runtime/reopen verbs (`resolveOwnedShuttleFiberAs`), so the ownership
// guard never round-tripped back to the daemon it was being shelled from.
// Post-S1, `resolveOwnHost` (see ensureOwnedHere) is pure local state — no
// round-trip to guard against — so every caller now takes this same path.
func resolveOwnedShuttleFiber(query, missingBlockHint string) (*felt.Felt, *felt.Storage, *shuttle.Block, func() error, error) {
	f, st, err := shuttleResolveFiber(query, true)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	f, unlock, err := lockAndReloadFiber(st, f)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	block, ok, err := f.ShuttleBlock()
	if err != nil {
		unlock()
		return nil, nil, nil, nil, err
	}
	if !ok {
		unlock()
		if missingBlockHint == "" {
			return nil, nil, nil, nil, fmt.Errorf("fiber %s has no shuttle: block", query)
		}
		return nil, nil, nil, nil, fmt.Errorf("fiber %s has no shuttle: block (%s)", query, missingBlockHint)
	}
	if err := ensureOwnedHere(f, query); err != nil {
		unlock()
		return nil, nil, nil, nil, err
	}
	return f, st, block, unlock, nil
}

// lockAndReloadFiber acquires f.ID's cross-process advisory lock (F4,
// internal/felt/lock.go) and re-reads it fresh from disk, so a resolver that
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
status:active is the sole dispatch gate; there is no enabled flag.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		f, st, _, unlock, err := resolveOwnedShuttleFiber(args[0], "")
		if err != nil {
			return err
		}
		defer unlock()

		statusBefore := f.Status
		f.Status = felt.StatusOpen
		if err := setTempered(f, nil); err != nil {
			return err
		}
		clearClosedAt(f)
		if err := st.Write(f); err != nil {
			return fmt.Errorf("writing fiber: %w", err)
		}
		fmt.Printf("paused %s (status: open; schedule preserved)\n", args[0])
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

		// Dual-recognition: kill whichever session form is live (a worker launched
		// before the uid-keyed cutover carries the legacy name).
		session := ""
		for _, candidate := range shuttleTmuxSessionNames(f.ID, f.UID) {
			if tmuxSessionExists(candidate) {
				session = candidate
				break
			}
		}
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

var resumeCmd = &cobra.Command{
	Use:   "resume <fiber>",
	Short: "Arm a paused fiber (status: active)",
	Long: `Sets the felt-native status to "active" — the sole dispatch gate — so the
daemon dispatches the fiber on its next poll.

For a standing role awaiting review (status: closed + untempered), resume re-arms
it for immediate dispatch and routes to the owning daemon (which clears the
awaiting marker and recomputes due-ness from the schedule), falling back to a
local document write when the daemon is unreachable. A draft (status: open) is
armed straight to active. Refuses on a tempered/composted close — use
'felt shuttle reopen' to requeue a finished fiber.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		f, st, block, unlock, err := resolveOwnedShuttleFiber(args[0], "")
		if err != nil {
			return err
		}
		defer unlock()

		// A standing role awaiting review (status:closed + untempered) re-arms
		// through the owning daemon, which clears the awaiting marker and
		// recomputes due-ness. Falls back to a local write when the daemon is down.
		docAwaiting := f.Status == felt.StatusClosed && readTempered(f) == nil
		if block.Kind == "standing" && docAwaiting {
			if output, err := postLifecycle("resume", map[string]any{"fiber": f.ID}); err == nil {
				fmt.Print(output)
				return nil
			} else if !isLifecycleTransportError(err) {
				return err
			}
			f.Status = felt.StatusActive
			if err := setTempered(f, nil); err != nil {
				return err
			}
			clearClosedAt(f)
			if err := st.Write(f); err != nil {
				return fmt.Errorf("writing fiber: %w", err)
			}
			fmt.Printf("resumed %s (standing role; re-queued for immediate dispatch)\n", args[0])
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
		fmt.Printf("resumed %s (status: active)\n", args[0])
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

// ---- close -----------------------------------------------------------------

var closeTempered string

var closeCmd = &cobra.Command{
	Use:   "close <fiber>",
	Short: "Close a shuttle-managed fiber and optionally set the human verdict",
	Long: `Sets status: closed, sets/clears tempered, and stamps closed-at when the
field is missing. Use:

  felt shuttle close <fiber>                   # awaiting review (tempered cleared)
  felt shuttle close <fiber> --tempered=true   # human-accepted
  felt shuttle close <fiber> --tempered=false  # composted / rejected

The shuttle block stays installed; closed fibers are ignored by the daemon
until they are reopened.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		f, st, _, unlock, err := resolveOwnedShuttleFiber(args[0], "")
		if err != nil {
			return err
		}
		defer unlock()

		var tempered *bool
		if closeTempered != "" {
			parsed, err := parseOptionalBool(closeTempered)
			if err != nil {
				return fmt.Errorf("parsing --tempered: %w", err)
			}
			tempered = parsed
		}

		f.Status = felt.StatusClosed
		if err := setTempered(f, tempered); err != nil {
			return err
		}
		setClosedAtIfMissing(f)
		if err := st.Write(f); err != nil {
			return fmt.Errorf("writing fiber: %w", err)
		}

		fmt.Printf("closed %s\n", args[0])
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

var reopenAsDraft bool

var reopenCmd = &cobra.Command{
	Use:   "reopen <fiber>",
	Short: "Requeue a closed or reviewed fiber back into active work",
	Long: `Sets status = active and clears tempered / closed-at so a previously closed
card re-enters the in-flight loop. status:active is the sole dispatch gate.

With --as-draft, sets status = open instead: the card reopens as a PAUSED DRAFT
— visible on the board, never auto-dispatched.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		f, st, _, unlock, err := resolveOwnedShuttleFiber(args[0], "")
		if err != nil {
			return err
		}
		defer unlock()

		status := felt.StatusActive
		if reopenAsDraft {
			status = felt.StatusOpen
		}
		statusBefore := f.Status
		f.Status = status
		if err := setTempered(f, nil); err != nil {
			return err
		}
		clearClosedAt(f)
		if err := st.Write(f); err != nil {
			return fmt.Errorf("writing fiber: %w", err)
		}

		fmt.Printf("reopened %s (status: %s)\n", args[0], status)
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
		f, st, _, unlock, err := resolveOwnedShuttleFiber(args[0], "")
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

		fmt.Printf("set outcome for %s\n", args[0])
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

var acceptKeepOutcome bool

var acceptCmd = &cobra.Command{
	Use:   "accept <fiber>",
	Short: "Accept a completed standing or pinned run (re-arm / re-park)",
	Long: `Resolves the human verdict on a role awaiting review (status: closed +
untempered), kind-aware:

  standing → re-arms it (status: active), clearing closed-at / tempered.
             Due-ness is recomputed by the daemon from the schedule (no stored
             next_due_at, no review block). Clears the outcome so the next
             dispatch starts blank; pass --keep-outcome to preserve it.
  pinned   → re-parks it back to the strip (status: open), clearing
             closed-at / tempered. A human Resume (force-dispatch) starts it
             again.

Routes to the owning daemon when reachable (a single in-process transition);
falls back to a local document write when the daemon is down.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		f, st, block, unlock, err := resolveOwnedShuttleFiber(args[0], "")
		if err != nil {
			return err
		}
		defer unlock()
		if block.Kind != "standing" && block.Kind != "pinned" {
			return fmt.Errorf("accept only applies to standing or pinned roles (fiber has kind=%s)", block.Kind)
		}
		// Awaiting is felt-native: status: closed + untempered.
		if !(f.Status == felt.StatusClosed && readTempered(f) == nil) {
			return fmt.Errorf(
				"fiber %s is not awaiting review (accept requires status:closed + untempered; status=%q tempered=%v)",
				args[0], f.Status, readTempered(f))
		}

		// PINNED accept RE-PARKS the finished arc back to the strip (status: open,
		// verdict cleared) — the kind-aware other half of accept (standing re-arms
		// active, pinned re-parks open). No schedule, no recurrence to advance.
		// Routes to the owning daemon (LifecycleStore.accept is kind-aware) with a
		// local-write fallback when the daemon is down.
		if block.Kind == "pinned" {
			if output, err := postLifecycle("accept", map[string]any{"fiber": f.ID}); err == nil {
				fmt.Print(output)
				return nil
			} else if !isLifecycleTransportError(err) {
				return err
			}
			f.Status = felt.StatusOpen
			if err := setTempered(f, nil); err != nil {
				return err
			}
			clearClosedAt(f)
			if err := st.Write(f); err != nil {
				return fmt.Errorf("writing fiber: %w", err)
			}
			fmt.Printf("accepted pinned role %s (re-parked to the strip: status: open)\n", args[0])
			return nil
		}

		if block.Schedule == nil {
			return fmt.Errorf("fiber %s has no schedule", args[0])
		}

		if output, err := postLifecycle("accept", map[string]any{
			"fiber":        f.ID,
			"keep_outcome": acceptKeepOutcome,
		}); err == nil {
			fmt.Print(output)
			return nil
		} else if !isLifecycleTransportError(err) {
			return err
		}

		// Offline fallback (daemon down). Re-arm straight from the doc schedule;
		// the daemon recomputes due-ness on its next poll.
		computedNext, err := shuttle.NextOccurrence(block.Schedule, time.Now())
		if err != nil {
			return fmt.Errorf("computing next occurrence: %w", err)
		}
		f.Status = felt.StatusActive
		if err := setTempered(f, nil); err != nil {
			return err
		}
		clearClosedAt(f)
		if !acceptKeepOutcome {
			f.Outcome = ""
		}
		// Stamp the same conclude-the-run signal the daemon-reachable path folds in
		// (LifecycleStore.accept -> conclude_run -> handed_off_at = now): the
		// poller's repeat-firing guard is `prev_due > last_serviced`, and
		// last_serviced_at_ms (standing_roles.ex:385) is the max of dispatched_at /
		// handed_off_at / rearmed_at / created_at. Without a fresh handed_off_at
		// here, last_serviced stays pinned at the PREVIOUS dispatch, so the guard is
		// immediately satisfied and the role fires on the very next poll — while
		// this command just printed a next-due tomorrow morning. UTC instant, same
		// as every other stamp on this path (and matching the wire format
		// stampHandedOff uses in shuttle_handoff.go).
		if err := f.SetShuttleRuntimeField("handed_off_at", time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			return fmt.Errorf("stamping handed_off_at: %w", err)
		}
		if err := st.Write(f); err != nil {
			return fmt.Errorf("writing fiber: %w", err)
		}
		fmt.Printf("accepted run for %s\n  next due: %s\n", args[0], computedNext.Format(time.RFC3339))
		return nil
	},
}

// ---- set-model -------------------------------------------------------------

var setModelCmd = &cobra.Command{
	Use:   "set-model <fiber> <agent>",
	Short: "Change the dispatch agent for a fiber",
	Long: `Updates shuttle.agent to the given agent ID, validated against the agent
registry (together with the block's existing effort/chrome axes) before writing.
The single field is set surgically so the daemon-owned runtime keys are
preserved.`,
	Args: cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		reg, err := shuttle.LoadAgentRegistry()
		if err != nil {
			return fmt.Errorf("loading agent registry: %w", err)
		}
		f, st, block, unlock, err := resolveOwnedShuttleFiber(args[0], "use 'felt shuttle repeat' to install first")
		if err != nil {
			return err
		}
		defer unlock()

		agentID := args[1]
		// Resolve the new base agent together with the block's existing axes:
		// switching to an agent that can't carry the current effort/chrome fails
		// loud here rather than silently at dispatch.
		if _, _, err := reg.Resolve(agentID, block.Effort, block.Chrome); err != nil {
			return err
		}

		if err := f.SetShuttleField("agent", agentID); err != nil {
			return err
		}
		if err := st.Write(f); err != nil {
			return fmt.Errorf("writing fiber: %w", err)
		}

		fmt.Printf("set agent for %s → %s\n", args[0], agentID)
		return nil
	},
}

// ---- set-agent -------------------------------------------------------------

var (
	setAgentEffort string
	setAgentChrome bool
)

// setAgentCmd is the axis-aware mutation verb: it composes base agent × effort ×
// chrome in one validated write. set-model stays the narrow base-agent verb; this
// is the superset. Each axis is set surgically (a real !!bool for chrome, a
// delete for a cleared effort/agent) so the runtime keys are preserved.
var setAgentCmd = &cobra.Command{
	Use:   "set-agent <fiber> [agent]",
	Short: "Set the dispatch agent and/or axes (effort, chrome) for a fiber",
	Long: `Composes a fiber's dispatch axes — base agent, effort, chrome — and writes
them to the shuttle: block after validating the combination against the agent
registry's per-harness constraints. The base agent argument is optional: omit it
to mutate only the axes of the current agent. Pass --effort "" to clear effort
back to the harness default.`,
	Args: cobra.RangeArgs(1, 2),
	RunE: func(cmd *cobra.Command, args []string) error {
		reg, err := shuttle.LoadAgentRegistry()
		if err != nil {
			return fmt.Errorf("loading agent registry: %w", err)
		}
		f, st, block, unlock, err := resolveOwnedShuttleFiber(args[0], "use 'felt shuttle repeat' to install first")
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

		// Validate the full composition before writing.
		name := agentID
		if name == "" {
			if def, err := reg.Default(); err == nil {
				name = def.ID
			}
		}
		if _, _, err := reg.Resolve(name, effort, chrome); err != nil {
			return err
		}

		// Surgical, omitempty-aware writes: a cleared agent/effort drops its key,
		// chrome is written as a real bool (or dropped when false).
		if err := f.SetShuttleNodeField("agent", axisValue(agentID)); err != nil {
			return err
		}
		if err := f.SetShuttleNodeField("effort", axisValue(effort)); err != nil {
			return err
		}
		if chrome {
			if err := f.SetShuttleNodeField("chrome", true); err != nil {
				return err
			}
		} else if err := f.SetShuttleNodeField("chrome", nil); err != nil {
			return err
		}
		if err := st.Write(f); err != nil {
			return fmt.Errorf("writing fiber: %w", err)
		}

		fmt.Printf("set agent for %s → %s", args[0], shuttleNonEmpty(agentID, "(default)"))
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

// reshape is the surgical setter for `kind` — the one field on the shuttle:
// block that had no set-* verb of its own. Without it, changing a role's kind
// meant routing through a CREATE verb (the since-removed install/repeat/pin
// --reshape flag), which
// rebuilds the whole block from scratch: re-resolving project_dir and host,
// echoing agent, and (historically) settling status as a side effect. That
// indirection was a real bug source — a role in Awaiting review could not be
// re-shaped because armed-install refuses closed fibers. Here kind (and, for a
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
schedule-less kind never carries a stale recurrence; passing --schedule with one
is an error.

Requires an existing shuttle: block — use install / repeat / pin to create one.
This is a config edit, not a lifecycle move: it never changes status, so use
pause / resume / close / reopen for that.`,
	Args: cobra.RangeArgs(1, 2),
	RunE: func(cmd *cobra.Command, args []string) error {
		reg, err := shuttle.LoadAgentRegistry()
		if err != nil {
			return fmt.Errorf("loading agent registry: %w", err)
		}
		f, st, block, unlock, err := resolveOwnedShuttleFiber(args[0],
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
			if !cmd.Flags().Changed("tz") {
				tz = "UTC"
				if block.Schedule != nil && block.Schedule.TZ != "" {
					tz = block.Schedule.TZ
				}
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
			fmt.Printf("reshaped %s (kind: %s, unchanged)\n", args[0], kind)
		} else {
			fmt.Printf("reshaped %s (kind: %s → %s)\n", args[0], shuttleNonEmpty(block.Kind, "(unset)"), kind)
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
daemon will no longer dispatch it. The felt status and tags are not changed.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		f, st, err := shuttleResolveFiber(args[0], true)
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
		fmt.Printf("uninstalled %s (shuttle: block removed)\n", args[0])
		return nil
	},
}

// registerShuttleLifecycleFlags binds the lifecycle verbs' flags. Exposed so
// tests can ResetFlags() + re-register to clear Changed state between runs (the
// cobra flag-state-persists-across-Execute gotcha).
func registerShuttleLifecycleFlags() {
	pauseCmd.Flags().BoolVar(&pauseNoKill, "no-kill", false, "Only disable future dispatch; leave any live worker tmux session running")
	closeCmd.Flags().StringVar(&closeTempered, "tempered", "", "Set tempered verdict (true/false); omit to clear it for awaiting review")
	reopenCmd.Flags().BoolVar(&reopenAsDraft, "as-draft", false, "reopen to status: open (a paused draft, not auto-dispatched) instead of status: active")
	setOutcomeCmd.Flags().StringVar(&setOutcomeValue, "outcome", "", "Outcome text; omit to read from stdin")
	acceptCmd.Flags().BoolVar(&acceptKeepOutcome, "keep-outcome", false, "Preserve the existing outcome instead of clearing it for the next dispatch")
	setAgentCmd.Flags().StringVar(&setAgentEffort, "effort", "", `Effort level (harness-native token, e.g. low|medium|high|xhigh|max); "" clears`)
	setAgentCmd.Flags().BoolVar(&setAgentChrome, "chrome", false, "Enable chrome (claude harness only)")
	reshapeCmd.Flags().StringVarP(&reshapeSchedule, "schedule", "s", "", "Cron expression (5-field standard syntax); standing target only")
	reshapeCmd.Flags().StringVarP(&reshapeTZ, "tz", "z", "UTC", "IANA timezone name (default: the block's existing tz, else UTC); standing target only")
}

func init() {
	registerShuttleLifecycleFlags()

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
