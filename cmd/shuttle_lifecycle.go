package cmd

import (
	"fmt"
	"io"
	"os"
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

// resolveOwnedShuttleFiber is the common preamble for a lifecycle write verb: a
// full read (body preserved for the re-serialize), a required shuttle: block, and
// the ownership guard. Returns the fiber, its storage, and the typed block.
func resolveOwnedShuttleFiber(query string) (*felt.Felt, *felt.Storage, *shuttle.Block, error) {
	f, st, err := shuttleResolveFiber(query, true)
	if err != nil {
		return nil, nil, nil, err
	}
	block, ok, err := f.ShuttleBlock()
	if err != nil {
		return nil, nil, nil, err
	}
	if !ok {
		return nil, nil, nil, fmt.Errorf("fiber %s has no shuttle: block", query)
	}
	if err := ensureOwnedHere(f, query); err != nil {
		return nil, nil, nil, err
	}
	return f, st, block, nil
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
		f, st, _, err := resolveOwnedShuttleFiber(args[0])
		if err != nil {
			return err
		}

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
		f, st, block, err := resolveOwnedShuttleFiber(args[0])
		if err != nil {
			return err
		}

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
		f, st, _, err := resolveOwnedShuttleFiber(args[0])
		if err != nil {
			return err
		}

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
		f, st, _, err := resolveOwnedShuttleFiber(args[0])
		if err != nil {
			return err
		}

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
		f, st, _, err := resolveOwnedShuttleFiber(args[0])
		if err != nil {
			return err
		}

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
	Short: "Accept a completed standing-role run and re-arm it",
	Long: `Re-arms a standing role awaiting review (status: closed + untempered) by
writing status: active back to the document and clearing closed-at / tempered.
Due-ness is recomputed by the daemon from the schedule — there is no stored
next_due_at and no review block (status + tempered is the whole lifecycle).

Clears the outcome field so the next dispatch starts with a blank slate; pass
--keep-outcome to preserve the existing outcome.

Routes to the owning daemon when reachable (a single in-process re-arm); falls
back to a local document write when the daemon is down.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		f, st, block, err := resolveOwnedShuttleFiber(args[0])
		if err != nil {
			return err
		}
		if block.Kind != "standing" {
			return fmt.Errorf("accept only applies to standing roles (fiber has kind=%s)", block.Kind)
		}
		// Awaiting is felt-native: status: closed + untempered.
		if !(f.Status == felt.StatusClosed && readTempered(f) == nil) {
			return fmt.Errorf(
				"fiber %s is not awaiting review (accept requires status:closed + untempered; status=%q tempered=%v)",
				args[0], f.Status, readTempered(f))
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
		f, st, block, err := resolveShuttleFiberForConfig(args[0])
		if err != nil {
			return err
		}

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
		f, st, block, err := resolveShuttleFiberForConfig(args[0])
		if err != nil {
			return err
		}

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

// resolveShuttleFiberForConfig is the preamble for the config verbs
// (set-model/set-agent): like resolveOwnedShuttleFiber but with the "install
// first" hint on a missing block.
func resolveShuttleFiberForConfig(query string) (*felt.Felt, *felt.Storage, *shuttle.Block, error) {
	f, st, err := shuttleResolveFiber(query, true)
	if err != nil {
		return nil, nil, nil, err
	}
	block, ok, err := f.ShuttleBlock()
	if err != nil {
		return nil, nil, nil, err
	}
	if !ok {
		return nil, nil, nil, fmt.Errorf("fiber %s has no shuttle: block (use 'felt shuttle repeat' to install first)", query)
	}
	if err := ensureOwnedHere(f, query); err != nil {
		return nil, nil, nil, err
	}
	return f, st, block, nil
}

// ---- set-interactive (retired stub) ----------------------------------------

var setInteractiveCmd = &cobra.Command{
	Use:    "set-interactive <fiber> <true|false>",
	Short:  "(retired) interactivity is no longer a dispatch mode",
	Hidden: true,
	Args:   cobra.ArbitraryArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		return fmt.Errorf(`set-interactive is retired: interactivity is no longer a dispatch mode.
  - Per-dispatch "talk to me first" intent goes in the From User directive
    (the kanban requeue/resume box — it rides the dispatch call as a parameter).
  - Structural human-gates (2FA, send-in-his-voice) belong in the constitution
    text — the worker reads Desired State / Context and waits there.
  - To talk to any worker, finished or not, resume it from the kanban.`)
	},
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
	shuttleCmd.AddCommand(setInteractiveCmd)
	shuttleCmd.AddCommand(uninstallShuttleCmd)
}
