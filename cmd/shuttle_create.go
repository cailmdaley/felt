package cmd

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

// The create verbs — install (oneshot), repeat (standing), pin (pinned) — build a
// shuttle: block from scratch and attach it to an existing fiber. Because they
// CREATE the block (no daemon-owned runtime keys to preserve yet), they use
// felt's whole-key SetExtraField("shuttle", block) rather than the surgical
// setters the lifecycle config verbs use. The block is born owned: resolveOwnHost
// stamps an explicit host so the daemon's strict dispatch predicate (block.host
// == own_host_id) has a value to match. status (the sole dispatch gate) is set
// felt-native: install/repeat arm to active, pin parks at open. Ported from
// shuttle-ctl's install.go/repeat.go/pin.go.

var (
	installModel      string
	installProjectDir string
	installHost       string
	installDisabled   bool

	repeatSchedule   string
	repeatTZ         string
	repeatModel      string
	repeatProjectDir string
	repeatHost       string

	pinModel      string
	pinProjectDir string
	pinHost       string
)

// refuseExistingBlock is the one policy the three create verbs share: they
// CREATE, so a fiber that already carries a shuttle: block is a refusal, and the
// refusal routes the caller to the surgical verb for what they were trying to
// change. Nothing here rewrites a block — every in-place edit has its own verb,
// each of which preserves the daemon-owned runtime keys and the fiber's whole
// lifecycle (status / tempered / closed-at / outcome) that a rebuild-from-scratch
// could not.
//
// Ownership is checked first: a fiber another daemon owns gets the truer error,
// since the edit verbs below would refuse it on the same grounds.
func refuseExistingBlock(fiberID string, f *felt.Felt, b *shuttle.Block) error {
	if err := ensureOwnedHere(f, fiberID); err != nil {
		return err
	}
	return fmt.Errorf(`fiber %s already has a shuttle: block (kind=%s); the create verbs only create. To change it in place:
  kind or schedule:  felt shuttle reshape %s [kind] [--schedule ...]
  agent:             felt shuttle set-model %s <agent>   (set-agent for effort/chrome)
  inspect it:        felt shuttle status %s
  start over:        felt shuttle uninstall %s, then install / repeat / pin`,
		fiberID, shuttleNonEmpty(b.Kind, "(unset)"), fiberID, fiberID, fiberID, fiberID)
}

// printShuttleValidationErrors renders a constructed block's validation failures
// CLI-style and returns a terminal error, matching shuttle-ctl's output. Writes
// to os.Stderr (felt's verbs print directly, not via cmd.OutOrStdout).
func printShuttleValidationErrors(errs shuttle.ValidationErrors) error {
	fmt.Fprintln(os.Stderr, "shuttle: validation failed:")
	for _, e := range errs {
		fmt.Fprintf(os.Stderr, "  %s\n", e)
	}
	return fmt.Errorf("invalid input")
}

// ---- install ---------------------------------------------------------------

var installCmd = &cobra.Command{
	Use:   "install <fiber>",
	Short: "Install a fiber as a one-shot dispatch role",
	Long: `Install the fiber as a oneshot role: a one-time dispatch that the daemon
picks up on its next poll.

  felt shuttle install <fiber> --project-dir "$PWD"                      # armed, default agent
  felt shuttle install <fiber> --project-dir "$PWD" --model claude-opus  # explicit agent
  felt shuttle install <fiber> --disabled                                # land in drafts (status: open)

Dispatch is gated solely by the felt-native status field: status:active is
armed, status:open is a draft. An armed install requires --project-dir and sets
status:active; --disabled sets status:open. An install on a closed fiber is
refused — reopen it first.

install creates; it never rewrites. A fiber that already has a shuttle: block is
refused, with a pointer at the verb that edits in place (reshape for kind or
schedule, set-model / set-agent for the agent, uninstall to start over).`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		reg, err := shuttle.LoadAgentRegistry()
		if err != nil {
			return fmt.Errorf("loading agent registry: %w", err)
		}
		f, st, err := shuttleResolveFiber(args[0], true)
		if err != nil {
			return err
		}
		f, unlock, err := lockAndReloadFiber(st, f)
		if err != nil {
			return err
		}
		defer unlock()

		// A block already on the fiber is a refusal, not a rewrite (a
		// malformed-but-mapping block surfaces its decode error cleanly rather than
		// nil-dereferencing).
		existing, ok, err := f.ShuttleBlock()
		if err != nil {
			return err
		}
		if ok {
			return refuseExistingBlock(args[0], f, existing)
		}

		host, err := resolveOwnHost(installHost)
		if err != nil {
			return err
		}

		block := &shuttle.Block{Kind: "oneshot", Host: host}
		if installModel != "" {
			block.Agent = installModel
		}
		// An armed install requires a cwd. A draft does not — but an explicitly
		// passed one is still honored: the board's Promote button installs
		// --disabled WITH a project_dir, and nothing later supplies one (resume
		// only moves status), so dropping it would arm a role the poller then
		// disqualifies for having no usable project_dir — armed, and silently
		// never dispatched.
		if !installDisabled || cmd.Flags().Changed("project-dir") {
			projectDir, perr := resolveProjectDirFlag(installProjectDir)
			if perr != nil {
				return perr
			}
			block.ProjectDir = projectDir
		}
		if !installDisabled && strings.TrimSpace(block.Host) == "" {
			return fmt.Errorf("armed install requires a host (the owning daemon's host id; pass --host or run on the owning machine)")
		}

		if errs := shuttle.Validate(block, reg); len(errs) > 0 {
			return printShuttleValidationErrors(errs)
		}

		// A fresh create settles status: install arms to active, --disabled parks at
		// open. A closed fiber is a refusal — arming something already
		// reviewed-and-done needs an explicit reopen.
		statusBefore := f.Status
		statusChanged := false
		if installDisabled {
			if statusBefore != felt.StatusOpen {
				f.Status = felt.StatusOpen
				clearClosedAt(f)
				statusChanged = true
			}
		} else {
			if statusBefore == felt.StatusClosed {
				return fmt.Errorf("fiber %s has status: closed; use 'felt shuttle reopen %s' to requeue it, or set status: active before installing; use --disabled to park in drafts", args[0], args[0])
			}
			if statusBefore != felt.StatusActive {
				f.Status = felt.StatusActive
				statusChanged = true
			}
		}

		if err := f.SetShuttleConfig(block); err != nil {
			return fmt.Errorf("attaching shuttle block: %w", err)
		}
		if err := st.Write(f); err != nil {
			return fmt.Errorf("writing fiber: %w", err)
		}

		state := "armed"
		if installDisabled {
			state = "draft (status: open)"
		}
		fmt.Printf("installed %s as oneshot role (%s)\n", args[0], state)
		fmt.Printf("  host: %s\n", block.Host)
		if block.Agent != "" {
			fmt.Printf("  agent: %s\n", block.Agent)
		}
		if block.ProjectDir != "" {
			fmt.Printf("  project_dir: %s\n", block.ProjectDir)
		}
		if statusChanged {
			want := felt.StatusActive
			if installDisabled {
				want = felt.StatusOpen
			}
			if statusBefore == "" {
				fmt.Printf("  status: %s (set; was missing)\n", want)
			} else {
				fmt.Printf("  status: %s → %s\n", statusBefore, want)
			}
		}
		return nil
	},
}

// ---- repeat ----------------------------------------------------------------

var repeatCmd = &cobra.Command{
	Use:   "repeat <fiber>",
	Short: "Install a fiber as a standing (recurring) role",
	Long: `Install the fiber as a standing role on a recurring cron schedule.

The cron expression uses standard 5-field syntax: minute hour dom month dow.
The --tz flag must be an IANA timezone name (e.g. Europe/Paris, UTC).

  felt shuttle repeat <fiber> --schedule "0 9 * * 1-5" --tz Europe/Paris --project-dir "$PWD"

The running daemon picks it up on its next poll; a fresh standing role is born
armed (status:active), and a closed fiber is refused — reopen it first.

repeat creates; it never rewrites. A fiber that already has a shuttle: block is
refused — use 'felt shuttle reshape' to change its kind or re-time its schedule,
set-model / set-agent for the agent, uninstall to start over.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		reg, err := shuttle.LoadAgentRegistry()
		if err != nil {
			return fmt.Errorf("loading agent registry: %w", err)
		}
		f, st, err := shuttleResolveFiber(args[0], true)
		if err != nil {
			return err
		}
		f, unlock, err := lockAndReloadFiber(st, f)
		if err != nil {
			return err
		}
		defer unlock()
		// A block already on the fiber is a refusal, not a rewrite (a
		// malformed-but-mapping block surfaces its decode error cleanly rather than
		// nil-dereferencing).
		existing, hasBlock, err := f.ShuttleBlock()
		if err != nil {
			return err
		}
		if hasBlock {
			return refuseExistingBlock(args[0], f, existing)
		}
		projectDir, err := resolveProjectDirFlag(repeatProjectDir)
		if err != nil {
			return err
		}
		host, err := resolveOwnHost(repeatHost)
		if err != nil {
			return err
		}

		block := &shuttle.Block{
			Kind:       "standing",
			ProjectDir: projectDir,
			Host:       host,
			Schedule:   &shuttle.Schedule{Expr: repeatSchedule, TZ: repeatTZ},
		}
		if repeatModel != "" {
			block.Agent = repeatModel
		}

		if strings.TrimSpace(block.Host) == "" {
			return fmt.Errorf("repeat requires a host (the owning daemon's host id; pass --host or run on the owning machine)")
		}

		if errs := shuttle.Validate(block, reg); len(errs) > 0 {
			return printShuttleValidationErrors(errs)
		}

		next, err := shuttle.NextOccurrence(block.Schedule, time.Now())
		if err != nil {
			return fmt.Errorf("computing next occurrence: %w", err)
		}

		// A fresh standing role is born armed; a closed fiber needs an explicit
		// reopen before it can be armed again.
		statusBefore := f.Status
		statusChanged := false
		if statusBefore == felt.StatusClosed {
			return fmt.Errorf("fiber %s has status: closed; use 'felt shuttle reopen %s' to clear verdict fields and requeue it before installing", args[0], args[0])
		}
		if statusBefore != felt.StatusActive {
			f.Status = felt.StatusActive
			statusChanged = true
		}

		if err := f.SetShuttleConfig(block); err != nil {
			return fmt.Errorf("attaching shuttle block: %w", err)
		}
		if err := st.Write(f); err != nil {
			return fmt.Errorf("writing fiber: %w", err)
		}

		fmt.Printf("installed %s as standing role\n", args[0])
		fmt.Printf("  host:     %s\n", block.Host)
		fmt.Printf("  schedule: %s (%s)\n", repeatSchedule, repeatTZ)
		if block.Agent != "" {
			fmt.Printf("  agent:    %s\n", block.Agent)
		}
		fmt.Printf("  project_dir: %s\n", block.ProjectDir)
		fmt.Printf("  next due: %s\n", next.Format(time.RFC3339))
		if statusChanged {
			if statusBefore == "" {
				fmt.Println("  status:   active (set; was missing)")
			} else {
				fmt.Printf("  status:   %s → active\n", statusBefore)
			}
		}
		return nil
	},
}

// ---- pin -------------------------------------------------------------------

var pinCmd = &cobra.Command{
	Use:   "pin <fiber>",
	Short: "Install a fiber as a pinned, schedule-less perennial role",
	Long: `Install the fiber as a pinned role: a schedule-less umbrella concern that
rests PARKED on the board's pinned strip (status:open) until you start it.

  felt shuttle pin <fiber> --project-dir "$PWD"                      # parked, default agent
  felt shuttle pin <fiber> --project-dir "$PWD" --model claude-opus  # explicit agent

Started (status:active, via Resume / strip → In-flight) a worker attaches as an
interactive interface. From there it joins the unified lifecycle: a worker that
hands off cleanly (` + "`felt shuttle handoff`" + `) is relaunched fresh — a long autonomous
arc across clean sessions — while a dirty exit parks it back to the strip. When
the arc is done it closes to Awaiting review, and accepting it re-parks it to the
strip. Perennial: you park it, you don't delete it.

pin creates; it never rewrites. A fiber that already has a shuttle: block is
refused — use 'felt shuttle reshape <fiber> pinned' to convert an existing role
in place, set-model / set-agent for the agent, uninstall to start over.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		reg, err := shuttle.LoadAgentRegistry()
		if err != nil {
			return fmt.Errorf("loading agent registry: %w", err)
		}
		f, st, err := shuttleResolveFiber(args[0], true)
		if err != nil {
			return err
		}
		f, unlock, err := lockAndReloadFiber(st, f)
		if err != nil {
			return err
		}
		defer unlock()

		// A block already on the fiber is a refusal, not a rewrite.
		existing, ok, err := f.ShuttleBlock()
		if err != nil {
			return err
		}
		if ok {
			return refuseExistingBlock(args[0], f, existing)
		}

		host, err := resolveOwnHost(pinHost)
		if err != nil {
			return err
		}
		projectDir, err := resolveProjectDirFlag(pinProjectDir)
		if err != nil {
			return err
		}

		block := &shuttle.Block{Kind: "pinned", Host: host, ProjectDir: projectDir}
		if pinModel != "" {
			block.Agent = pinModel
		}
		if strings.TrimSpace(block.Host) == "" {
			return fmt.Errorf("pinned role requires a host (the owning daemon's host id; pass --host or run on the owning machine)")
		}

		if errs := shuttle.Validate(block, reg); len(errs) > 0 {
			return printShuttleValidationErrors(errs)
		}

		// Pinned rest is status:open "parked on the strip", so a pin settles any
		// prior status — including closed (revive as a parked role) — to open.
		statusBefore := f.Status
		statusChanged := false
		if statusBefore != felt.StatusOpen {
			f.Status = felt.StatusOpen
			clearClosedAt(f)
			statusChanged = true
		}

		if err := f.SetShuttleConfig(block); err != nil {
			return fmt.Errorf("attaching shuttle block: %w", err)
		}
		if err := st.Write(f); err != nil {
			return fmt.Errorf("writing fiber: %w", err)
		}

		fmt.Printf("pinned %s (parked on the strip; Resume to start it — it then relaunches on clean handoff, parks on dirty exit)\n", args[0])
		fmt.Printf("  host: %s\n", block.Host)
		if block.Agent != "" {
			fmt.Printf("  agent: %s\n", block.Agent)
		}
		fmt.Printf("  project_dir: %s\n", block.ProjectDir)
		if statusChanged {
			if statusBefore == "" {
				fmt.Println("  status: open (set; was missing)")
			} else {
				fmt.Printf("  status: %s → open\n", statusBefore)
			}
		}
		return nil
	},
}

// registerShuttleCreateFlags binds the create verbs' flags. Exposed so tests can
// ResetFlags() + re-register to clear Changed state between runs.
func registerShuttleCreateFlags() {
	installCmd.Flags().StringVarP(&installModel, "model", "m", "", "Agent ID (default: registry default)")
	installCmd.Flags().StringVar(&installProjectDir, "project-dir", "", "Worker cwd on the target host (required unless --disabled)")
	installCmd.Flags().StringVar(&installHost, "host", "", "Owning daemon's host id (default: local daemon's own_host_id; set for cross-host install)")
	installCmd.Flags().BoolVar(&installDisabled, "disabled", false, "Install as a draft (status: open); use 'felt shuttle resume' to arm it")

	repeatCmd.Flags().StringVarP(&repeatSchedule, "schedule", "s", "", "Cron expression (5-field standard syntax) — required")
	repeatCmd.Flags().StringVarP(&repeatTZ, "tz", "z", "UTC", "IANA timezone name (default: UTC)")
	repeatCmd.Flags().StringVarP(&repeatModel, "model", "m", "", "Agent ID (default: registry default)")
	repeatCmd.Flags().StringVar(&repeatProjectDir, "project-dir", "", "Worker cwd on the target host (required)")
	repeatCmd.Flags().StringVar(&repeatHost, "host", "", "Owning daemon's host id (default: local daemon's own_host_id; set for cross-host install)")
	_ = repeatCmd.MarkFlagRequired("schedule")

	pinCmd.Flags().StringVarP(&pinModel, "model", "m", "", "Agent ID (default: registry default)")
	pinCmd.Flags().StringVar(&pinProjectDir, "project-dir", "", "Worker cwd on the target host (required)")
	pinCmd.Flags().StringVar(&pinHost, "host", "", "Owning daemon's host id (default: local daemon's own_host_id; set for cross-host install)")
}

func init() {
	registerShuttleCreateFlags()
	shuttleCmd.AddCommand(installCmd)
	shuttleCmd.AddCommand(repeatCmd)
	shuttleCmd.AddCommand(pinCmd)
}
