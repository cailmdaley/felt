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
status:active; --disabled sets status:open. Closed fibers must be reopened first.

Idempotent: if the fiber already has a shuttle: block, install reports its
current state and exits 0 when no conflicting flags are passed. A conflicting
flag points at the right mutation verb (pause / resume / set-model / uninstall).`,
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

		// If a block already exists, treat install as idempotent state reporting +
		// conflict detection (read-only, no write). A malformed-but-mapping block
		// surfaces its decode error cleanly rather than nil-dereferencing.
		existing, ok, err := f.ShuttleBlock()
		if err != nil {
			return err
		}
		if ok {
			return reportExistingBlock(cmd, args[0], f, existing, installModel, installDisabled, installProjectDir, installHost)
		}

		host, err := resolveOwnHost(installHost)
		if err != nil {
			return err
		}

		block := &shuttle.Block{Kind: "oneshot", Host: host}
		if installModel != "" {
			block.Agent = installModel
		}
		if !installDisabled {
			projectDir, err := resolveProjectDirFlag(installProjectDir)
			if err != nil {
				return err
			}
			block.ProjectDir = projectDir
			if strings.TrimSpace(block.Host) == "" {
				return fmt.Errorf("armed install requires a host (the owning daemon's host id; pass --host or run on the owning machine)")
			}
		}

		if errs := shuttle.Validate(block, reg); len(errs) > 0 {
			return printShuttleValidationErrors(errs)
		}

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
				return fmt.Errorf("fiber %s has status: closed; use 'felt shuttle reopen %s' when it already has a shuttle block, or set status: active before installing; use --disabled to park in drafts", args[0], args[0])
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

// reportExistingBlock prints the current block state and either returns nil
// (idempotent confirmation) or an error pointing at the right mutation verb when
// an explicitly-passed flag disagrees with the existing block. Read-only: it
// never writes the fiber.
func reportExistingBlock(cmd *cobra.Command, fiberID string, f *felt.Felt, b *shuttle.Block, model string, disabled bool, projectDir string, host string) error {
	statusNow := f.Status
	armed := statusNow == felt.StatusActive
	draft := statusNow == felt.StatusOpen

	headline := fmt.Sprintf("shuttle: fiber %s already has a shuttle: block (install is idempotent).", fiberID)
	if b.Kind == "standing" {
		headline = fmt.Sprintf("shuttle: fiber %s already has a standing-role shuttle: block.", fiberID)
	}
	fmt.Println(headline)
	fmt.Println("")
	writeBlockSummary(os.Stdout, b, statusNow, armed)

	fmt.Println("")
	switch {
	case statusNow == felt.StatusClosed:
		fmt.Printf("→ Fiber is closed — daemon will NOT dispatch. Use `felt shuttle reopen %s` to clear verdict fields and requeue it.\n", fiberID)
	case armed:
		fmt.Println("→ Daemon will dispatch on next poll. No action needed.")
	case draft:
		fmt.Printf("→ Draft (status: open). Use `felt shuttle resume %s` to arm it.\n", fiberID)
	case statusNow == "":
		fmt.Printf("→ Status missing — daemon will NOT dispatch. Use `felt shuttle resume %s` or set status: active in the markdown.\n", fiberID)
	default:
		fmt.Printf("→ Status %q is not armed — daemon will NOT dispatch. Use `felt shuttle resume %s` to set status: active.\n", statusNow, fiberID)
	}

	modelChanged := cmd.Flags().Changed("model")
	disabledChanged := cmd.Flags().Changed("disabled")
	projectDirChanged := cmd.Flags().Changed("project-dir")
	hostChanged := cmd.Flags().Changed("host")

	var mismatches []string
	if hostChanged && strings.TrimSpace(host) != b.Host {
		mismatches = append(mismatches,
			fmt.Sprintf("--host %s ≠ current host %q  →  felt shuttle uninstall %s && felt shuttle install %s --host %s",
				host, b.Host, fiberID, fiberID, host))
	}
	if modelChanged && model != b.Agent {
		mismatches = append(mismatches,
			fmt.Sprintf("--model %s ≠ current agent %q  →  felt shuttle set-model %s %s",
				model, b.Agent, fiberID, model))
	}
	if disabledChanged {
		if disabled && armed {
			mismatches = append(mismatches,
				fmt.Sprintf("--disabled passed but fiber is armed (status: active)  →  felt shuttle pause %s", fiberID))
		} else if !disabled && draft {
			mismatches = append(mismatches,
				fmt.Sprintf("--disabled=false passed but fiber is a draft (status: open)  →  felt shuttle resume %s", fiberID))
		}
	}
	if projectDirChanged {
		expanded, err := resolveProjectDirFlag(projectDir)
		if err == nil && expanded != b.ProjectDir {
			mismatches = append(mismatches,
				fmt.Sprintf("--project-dir %s ≠ current %q  →  felt shuttle uninstall %s && felt shuttle install %s --project-dir %s",
					expanded, b.ProjectDir, fiberID, fiberID, expanded))
		}
	}
	if len(mismatches) > 0 {
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "Conflicts with current block:")
		for _, m := range mismatches {
			fmt.Fprintf(os.Stderr, "  %s\n", m)
		}
		return fmt.Errorf("install would mutate existing block; use the verbs above")
	}

	return nil
}

// writeBlockSummary writes the human-readable "Current block:" report. Dispatch
// eligibility is the felt-native status alone (status:active = armed).
func writeBlockSummary(out io.Writer, b *shuttle.Block, statusNow string, armed bool) {
	fmt.Fprintln(out, "Current block:")
	fmt.Fprintf(out, "  kind:        %s\n", shuttleNonEmpty(b.Kind, "(unset)"))
	fmt.Fprintf(out, "  host:        %s\n", shuttleNonEmpty(b.Host, "(unset — NOT eligible on any daemon)"))
	if b.Agent != "" {
		fmt.Fprintf(out, "  agent:       %s\n", b.Agent)
	}
	if b.ProjectDir != "" {
		fmt.Fprintf(out, "  project_dir: %s\n", b.ProjectDir)
	}
	if b.Schedule != nil {
		fmt.Fprintf(out, "  schedule:    %q tz=%s\n", b.Schedule.Expr, b.Schedule.TZ)
	}

	switch {
	case statusNow == "":
		fmt.Fprintln(out, "  status:      (missing — NOT armed; resume or set status: active in the markdown)")
	case statusNow == felt.StatusClosed:
		fmt.Fprintln(out, "  status:      closed (NOT armed — daemon ignores closed fibers)")
	case statusNow == felt.StatusOpen:
		fmt.Fprintln(out, "  status:      open (draft — NOT armed; resume to dispatch)")
	case armed:
		fmt.Fprintf(out, "  status:      %s (armed)\n", statusNow)
	default:
		fmt.Fprintf(out, "  status:      %s\n", statusNow)
	}
}

// ---- repeat ----------------------------------------------------------------

var repeatCmd = &cobra.Command{
	Use:   "repeat <fiber>",
	Short: "Install a fiber as a standing (recurring) role",
	Long: `Install the fiber as a standing role on a recurring cron schedule.

The cron expression uses standard 5-field syntax: minute hour dom month dow.
The --tz flag must be an IANA timezone name (e.g. Europe/Paris, UTC).

  felt shuttle repeat <fiber> --schedule "0 9 * * 1-5" --tz Europe/Paris --project-dir "$PWD"

The running daemon picks it up on its next poll.`,
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
		// Capture any existing block up front (a malformed-but-mapping block
		// surfaces its decode error cleanly rather than nil-dereferencing).
		existing, hasBlock, err := f.ShuttleBlock()
		if err != nil {
			return err
		}
		// repeat is the one create verb that rewrites an EXISTING block, so it must
		// pass the ownership guard — refusing to mirror-write a fiber another daemon
		// owns (fail-open on a fresh / host-less fiber).
		if err := ensureOwnedHere(f, args[0]); err != nil {
			return err
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
		} else if hasBlock && existing.Agent != "" {
			// Inherit the agent from the block being replaced when --model is omitted.
			block.Agent = existing.Agent
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

Started (status:active, via Resume / strip → In-flight) a worker attaches and
stays alive as a standing interface; it never auto-dispatches, and on session
end it parks back to the strip. Perennial: you park it, you don't delete it.`,
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

		existing, ok, err := f.ShuttleBlock()
		if err != nil {
			return err
		}
		if ok {
			return fmt.Errorf("fiber %s already has a shuttle: block (kind=%s); uninstall it first to re-pin", args[0], existing.Kind)
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

		// Pinned rest is status:open "parked on the strip". Any prior status —
		// including closed (revive as a parked role) — settles to open.
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

		fmt.Printf("pinned %s (parked on the strip; Resume to attach a worker)\n", args[0])
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
