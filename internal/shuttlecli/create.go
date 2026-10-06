package shuttlecli

import (
	"fmt"
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
// felt-native: install/repeat arm to active, pin parks at open.

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
func (a *app) refuseExistingBlock(fiberID string, f *felt.Felt, b *shuttle.Block) error {
	if err := a.ensureOwnedHere(f, fiberID); err != nil {
		return err
	}
	return fmt.Errorf(`fiber %s already has a shuttle: block (kind=%s); the create verbs only create. To change it in place:
  kind or schedule:  shuttle reshape %s [kind] [--schedule ...]
  agent:             shuttle set-model %s <agent>   (set-agent for effort/chrome)
  inspect it:        shuttle status %s
  start over:        shuttle uninstall %s, then install / repeat / pin`,
		fiberID, shuttleNonEmpty(b.Kind, "(unset)"), fiberID, fiberID, fiberID, fiberID)
}

// printShuttleValidationErrors renders a constructed block's validation failures
// CLI-style to the invocation's stderr and returns a terminal error.
func (a *app) printShuttleValidationErrors(errs shuttle.ValidationErrors) error {
	fmt.Fprintln(a.env.Stderr, "shuttle: validation failed:")
	for _, e := range errs {
		fmt.Fprintf(a.env.Stderr, "  %s\n", e)
	}
	return fmt.Errorf("invalid input")
}

// ---- install ---------------------------------------------------------------

func (a *app) installCmd() *cobra.Command {
	var installModel string
	var installProjectDir string
	var installHost string
	var installDisabled bool
	var installSurface string
	installCmd := &cobra.Command{
		Use:   "install <fiber>",
		Short: "Install a fiber as a one-shot dispatch role",
		Long: `Install the fiber as a oneshot role: a one-time dispatch that the daemon
picks up on its next poll (after a daemon restart, once the boot quarantine is
released).

  shuttle install <fiber> --project-dir "$PWD"                      # armed, default agent
  shuttle install <fiber> --project-dir "$PWD" --model claude-opus  # explicit agent
  shuttle install <fiber> --project-dir "$PWD" --disabled           # land in drafts (status: open)

On the fiber, dispatch is switched by the felt-native status field alone (there
is no enabled flag): status:active is armed, status:open is a draft. An armed
install requires --project-dir and sets status:active; an armed install on a
closed fiber is refused — reopen it first. --disabled sets status:open (from
any prior status) and makes --project-dir optional; 'shuttle resume'
arms only a block that has one, so a draft installed without it is armed with
'shuttle resume <fiber> --project-dir <dir>'.

install creates; it never rewrites. A fiber that already has a shuttle: block is
refused, with a pointer at the verb that edits in place (reshape for kind or
schedule, set-model / set-agent for the agent, uninstall to start over).`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			reg, err := shuttle.LoadAgentRegistry(a.env)
			if err != nil {
				return fmt.Errorf("loading agent registry: %w", err)
			}
			f, st, err := a.shuttleResolveFiber(args[0], true)
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
			existing, ok, err := shuttle.BlockOf(f)
			if err != nil {
				return err
			}
			if ok {
				return a.refuseExistingBlock(args[0], f, existing)
			}

			host, err := a.resolveOwnHost(installHost)
			if err != nil {
				return err
			}

			block := &shuttle.Block{Kind: "oneshot", Host: host}
			if installModel != "" {
				block.Agent = installModel
			}
			if surface, serr := newBlockSurface(block, installSurface, reg); serr != nil {
				return serr
			} else {
				block.Surface = surface
			}
			// An armed install requires a cwd. A draft does not — but an explicitly
			// passed one is still honored (the board's Promote button installs
			// --disabled WITH a project_dir): arming later refuses a block
			// without one.
			if !installDisabled || cmd.Flags().Changed("project-dir") {
				projectDir, perr := a.resolveProjectDirFlag(installProjectDir)
				if perr != nil {
					return perr
				}
				block.ProjectDir = projectDir
			}

			if errs := shuttle.Validate(block, reg); len(errs) > 0 {
				return a.printShuttleValidationErrors(errs)
			}

			// A fresh create settles status: install arms to active, --disabled parks at
			// open. A closed fiber is a refusal — arming something already
			// reviewed-and-done needs an explicit reopen.
			statusBefore := f.Status
			statusChanged := false
			if installDisabled {
				if statusBefore != felt.StatusOpen {
					f.Status, f.ClosedAt = felt.StatusOpen, nil
					statusChanged = true
				}
			} else {
				if statusBefore == felt.StatusClosed {
					return fmt.Errorf("fiber %s has status: closed; use 'shuttle reopen %s' to requeue it, or set status: active before installing; use --disabled to park in drafts", args[0], args[0])
				}
				if statusBefore != felt.StatusActive {
					f.Status = felt.StatusActive
					statusChanged = true
				}
			}

			if err := shuttle.SetConfig(f, block); err != nil {
				return fmt.Errorf("attaching shuttle block: %w", err)
			}
			if err := st.Write(f); err != nil {
				return fmt.Errorf("writing fiber: %w", err)
			}

			state := "armed"
			if installDisabled {
				state = "draft, status: open"
			}
			fmt.Fprintf(a.env.Stdout, "installed %s as oneshot role (%s)\n", args[0], state)
			fmt.Fprintf(a.env.Stdout, "  host: %s\n", block.Host)
			if block.Agent != "" {
				fmt.Fprintf(a.env.Stdout, "  agent: %s\n", block.Agent)
			}
			if block.ProjectDir != "" {
				fmt.Fprintf(a.env.Stdout, "  project_dir: %s\n", block.ProjectDir)
			}
			if statusChanged {
				want := felt.StatusActive
				if installDisabled {
					want = felt.StatusOpen
				}
				if statusBefore == "" {
					fmt.Fprintf(a.env.Stdout, "  status: %s (set; was missing)\n", want)
				} else {
					fmt.Fprintf(a.env.Stdout, "  status: %s → %s\n", statusBefore, want)
				}
			}
			return nil
		},
	}
	installCmd.Flags().StringVarP(&installModel, "model", "m", "", "Agent ID (default: registry default)")
	installCmd.Flags().StringVar(&installProjectDir, "project-dir", "", "Worker cwd, an existing directory on this machine (stored absolute); required unless --disabled")
	installCmd.Flags().StringVar(&installHost, "host", "", "Owning daemon's host id (default: this host's id, as 'shuttle host' reports it; set for a cross-host install)")
	installCmd.Flags().BoolVar(&installDisabled, "disabled", false, "Install as a draft (status: open); arm it later with 'shuttle resume'")
	installCmd.Flags().StringVar(&installSurface, "surface", "", "Execution surface: cli or app (Codex defaults to app when omitted)")
	return installCmd
}

// ---- repeat ----------------------------------------------------------------

func (a *app) repeatCmd() *cobra.Command {
	var repeatSchedule string
	var repeatTZ string
	var repeatModel string
	var repeatProjectDir string
	var repeatHost string
	var repeatSurface string
	repeatCmd := &cobra.Command{
		Use:   "repeat <fiber>",
		Short: "Install a fiber as a standing (recurring) role",
		Long: `Install the fiber as a standing role on a recurring cron schedule.

The cron expression uses standard 5-field syntax: minute hour dom month dow.
The --tz flag must be an IANA timezone name (e.g. Europe/Paris, UTC).

  shuttle repeat <fiber> --schedule "0 9 * * 1-5" --tz Europe/Paris --project-dir "$PWD"

The running daemon picks it up on its next poll; a fresh standing role is born
armed (status:active), and a closed fiber is refused — reopen it first.

repeat creates; it never rewrites. A fiber that already has a shuttle: block is
refused — use 'shuttle reshape' to change its kind or re-time its schedule,
set-model / set-agent for the agent, uninstall to start over.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			reg, err := shuttle.LoadAgentRegistry(a.env)
			if err != nil {
				return fmt.Errorf("loading agent registry: %w", err)
			}
			f, st, err := a.shuttleResolveFiber(args[0], true)
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
			existing, hasBlock, err := shuttle.BlockOf(f)
			if err != nil {
				return err
			}
			if hasBlock {
				return a.refuseExistingBlock(args[0], f, existing)
			}
			projectDir, err := a.resolveProjectDirFlag(repeatProjectDir)
			if err != nil {
				return err
			}
			host, err := a.resolveOwnHost(repeatHost)
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
			if surface, serr := newBlockSurface(block, repeatSurface, reg); serr != nil {
				return serr
			} else {
				block.Surface = surface
			}

			if errs := shuttle.Validate(block, reg); len(errs) > 0 {
				return a.printShuttleValidationErrors(errs)
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
				return fmt.Errorf("fiber %s has status: closed; use 'shuttle reopen %s' to clear verdict fields and requeue it before installing", args[0], args[0])
			}
			if statusBefore != felt.StatusActive {
				f.Status = felt.StatusActive
				statusChanged = true
			}

			if err := shuttle.SetConfig(f, block); err != nil {
				return fmt.Errorf("attaching shuttle block: %w", err)
			}
			if err := st.Write(f); err != nil {
				return fmt.Errorf("writing fiber: %w", err)
			}

			fmt.Fprintf(a.env.Stdout, "installed %s as standing role\n", args[0])
			fmt.Fprintf(a.env.Stdout, "  host:     %s\n", block.Host)
			fmt.Fprintf(a.env.Stdout, "  schedule: %s (%s)\n", repeatSchedule, repeatTZ)
			if block.Agent != "" {
				fmt.Fprintf(a.env.Stdout, "  agent:    %s\n", block.Agent)
			}
			fmt.Fprintf(a.env.Stdout, "  project_dir: %s\n", block.ProjectDir)
			fmt.Fprintf(a.env.Stdout, "  next due: %s\n", next.Format(time.RFC3339))
			if statusChanged {
				if statusBefore == "" {
					fmt.Fprintln(a.env.Stdout, "  status:   active (set; was missing)")
				} else {
					fmt.Fprintf(a.env.Stdout, "  status:   %s → active\n", statusBefore)
				}
			}
			return nil
		},
	}
	repeatCmd.Flags().StringVarP(&repeatSchedule, "schedule", "s", "", "Cron expression (5-field standard syntax) — required")
	repeatCmd.Flags().StringVarP(&repeatTZ, "tz", "z", "UTC", "IANA timezone name")
	repeatCmd.Flags().StringVarP(&repeatModel, "model", "m", "", "Agent ID (default: registry default)")
	repeatCmd.Flags().StringVar(&repeatProjectDir, "project-dir", "", "Worker cwd, an existing directory on this machine (stored absolute); required")
	repeatCmd.Flags().StringVar(&repeatHost, "host", "", "Owning daemon's host id (default: this host's id, as 'shuttle host' reports it; set for a cross-host install)")
	repeatCmd.Flags().StringVar(&repeatSurface, "surface", "", "Execution surface: cli or app (Codex defaults to app when omitted)")
	_ = repeatCmd.MarkFlagRequired("schedule")
	return repeatCmd
}

// ---- pin -------------------------------------------------------------------

func (a *app) pinCmd() *cobra.Command {
	var pinModel string
	var pinProjectDir string
	var pinHost string
	var pinSurface string
	pinCmd := &cobra.Command{
		Use:   "pin <fiber>",
		Short: "Install a fiber as a pinned, schedule-less perennial role",
		Long: `Install the fiber as a pinned role: a schedule-less umbrella concern that
rests PARKED on the board's pinned strip (status:open) until you start it.

  shuttle pin <fiber> --project-dir "$PWD"                      # parked, default agent
  shuttle pin <fiber> --project-dir "$PWD" --model claude-opus  # explicit agent

Started (status:active, via Resume / strip → In-flight) a worker attaches as an
interactive interface. From there it joins the unified lifecycle: a worker that
hands off cleanly (` + "`shuttle handoff`" + `) is relaunched fresh — a long autonomous
arc across clean sessions — while a dirty exit parks it back to the strip. When
the arc is done it closes to Awaiting review, and accepting it re-parks it to the
strip. Perennial: you park it, you don't delete it.

pin creates; it never rewrites. A fiber that already has a shuttle: block is
refused — use 'shuttle reshape <fiber> pinned' to convert an existing role
in place, set-model / set-agent for the agent, uninstall to start over.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			reg, err := shuttle.LoadAgentRegistry(a.env)
			if err != nil {
				return fmt.Errorf("loading agent registry: %w", err)
			}
			f, st, err := a.shuttleResolveFiber(args[0], true)
			if err != nil {
				return err
			}
			f, unlock, err := lockAndReloadFiber(st, f)
			if err != nil {
				return err
			}
			defer unlock()

			// A block already on the fiber is a refusal, not a rewrite.
			existing, ok, err := shuttle.BlockOf(f)
			if err != nil {
				return err
			}
			if ok {
				return a.refuseExistingBlock(args[0], f, existing)
			}

			host, err := a.resolveOwnHost(pinHost)
			if err != nil {
				return err
			}
			projectDir, err := a.resolveProjectDirFlag(pinProjectDir)
			if err != nil {
				return err
			}

			block := &shuttle.Block{Kind: "pinned", Host: host, ProjectDir: projectDir}
			if pinModel != "" {
				block.Agent = pinModel
			}
			if surface, serr := newBlockSurface(block, pinSurface, reg); serr != nil {
				return serr
			} else {
				block.Surface = surface
			}

			if errs := shuttle.Validate(block, reg); len(errs) > 0 {
				return a.printShuttleValidationErrors(errs)
			}

			// Pinned rest is status:open "parked on the strip", so a pin settles any
			// prior status — including closed (revive as a parked role) — to open.
			statusBefore := f.Status
			statusChanged := false
			if statusBefore != felt.StatusOpen {
				f.Status, f.ClosedAt = felt.StatusOpen, nil
				statusChanged = true
			}

			if err := shuttle.SetConfig(f, block); err != nil {
				return fmt.Errorf("attaching shuttle block: %w", err)
			}
			if err := st.Write(f); err != nil {
				return fmt.Errorf("writing fiber: %w", err)
			}

			fmt.Fprintf(a.env.Stdout, "pinned %s (parked on the strip; Resume to start it — it then relaunches on clean handoff, parks on dirty exit)\n", args[0])
			fmt.Fprintf(a.env.Stdout, "  host: %s\n", block.Host)
			if block.Agent != "" {
				fmt.Fprintf(a.env.Stdout, "  agent: %s\n", block.Agent)
			}
			fmt.Fprintf(a.env.Stdout, "  project_dir: %s\n", block.ProjectDir)
			if statusChanged {
				if statusBefore == "" {
					fmt.Fprintln(a.env.Stdout, "  status: open (set; was missing)")
				} else {
					fmt.Fprintf(a.env.Stdout, "  status: %s → open\n", statusBefore)
				}
			}
			return nil
		},
	}
	pinCmd.Flags().StringVarP(&pinModel, "model", "m", "", "Agent ID (default: registry default)")
	pinCmd.Flags().StringVar(&pinProjectDir, "project-dir", "", "Worker cwd, an existing directory on this machine (stored absolute); required")
	pinCmd.Flags().StringVar(&pinHost, "host", "", "Owning daemon's host id (default: this host's id, as 'shuttle host' reports it; set for a cross-host install)")
	pinCmd.Flags().StringVar(&pinSurface, "surface", "", "Execution surface: cli or app (Codex defaults to app when omitted)")
	return pinCmd
}

// newBlockSurface applies the creation-only transport default. Absence remains
// CLI on a stored block for compatibility, but a newly created Codex role
// starts in the app unless the caller explicitly asks for CLI.
func newBlockSurface(block *shuttle.Block, requested string, reg *shuttle.AgentRegistry) (string, error) {
	if requested != "" {
		return requested, nil
	}
	name := block.Agent
	if name == "" {
		def, err := reg.Default()
		if err != nil {
			return "", err
		}
		name = def.ID
	}
	base, _, err := reg.Resolve(name, block.Effort, block.Chrome)
	if err != nil {
		return "", err
	}
	if base.CLI == "codex" {
		return "app", nil
	}
	return "", nil
}
