package cmd

import (
	"fmt"
	"strings"

	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

// felt shuttle agents — the registry surface. felt owns agents.json (the single
// source of truth); these verbs expose it so the networked daemon keeps zero
// registry knowledge of its own:
//
//   - `felt shuttle agents [--json]`  → the full registry (every record + its
//     axis-constraint metadata). The daemon's GET /api/v1/agents passes the JSON
//     through to the browser's agent picker, which reads effort_levels /
//     chrome_capable / default to build its constrained controls.
//   - `felt shuttle agents resolve <name> [--effort E] [--chrome]` → the single
//     effective ResolvedAgent (base record + applied axes), the byte-identical
//     shape `felt show -j` emits under shuttle.resolved.agent. The daemon's
//     capture/stash path — the one resolution with no fiber on disk to carry a
//     resolved sub-key — shells this instead of re-implementing the registry.
//
// Both are pure reads of the embedded registry; neither touches the felt store,
// so no -C / --felt-store context is required.

var (
	agentsResolveEffort string
	agentsResolveChrome bool
)

var shuttleAgentsCmd = &cobra.Command{
	Use:   "agents",
	Short: "List the agent registry felt owns (the single source of truth)",
	Long: `Print the agent registry felt embeds — every base agent and alias with
its axis-constraint metadata (effort_levels, default_effort, chrome_capable).

--json emits the bare array the daemon's GET /api/v1/agents serves to the
browser's agent picker. Without it, a readable table.`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		reg, err := shuttle.LoadAgentRegistry()
		if err != nil {
			return fmt.Errorf("loading agent registry: %w", err)
		}
		records := reg.Records()
		if jsonOutput {
			return outputJSON(records)
		}
		for _, a := range records {
			if a.IsAlias() {
				fmt.Printf("%-22s → %s%s\n", a.ID, a.AliasOf, formatAlias(a))
				continue
			}
			marker := " "
			if a.Default {
				marker = "*"
			}
			fmt.Printf("%s %-22s %-7s %-16s%s\n", marker, a.ID, a.CLI, a.Model, formatConstraints(a))
		}
		return nil
	},
}

var shuttleAgentsResolveCmd = &cobra.Command{
	Use:   "resolve <agent>",
	Short: "Resolve an agent name + axes to its effective record",
	Long: `Resolve an agent name and the requested axes (effort, chrome) to the
effective record the daemon launches: base cli/wrapper/model/extra_flags plus
the post-overlay effort/chrome/headless. The output shape is identical to
` + "`felt show -j`" + `'s shuttle.resolved.agent.

Errors (non-zero exit) on an unknown agent, a dangling alias, or an axis the
agent does not support — so a caller can distinguish a constraint violation
from a successful resolve.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		reg, err := shuttle.LoadAgentRegistry()
		if err != nil {
			return fmt.Errorf("loading agent registry: %w", err)
		}
		rec, axes, err := reg.Resolve(args[0], agentsResolveEffort, agentsResolveChrome)
		if err != nil {
			return err
		}
		resolved := shuttle.NewResolvedAgent(rec, axes)
		if jsonOutput {
			return outputJSON(resolved)
		}
		fmt.Printf("id:          %s\n", resolved.ID)
		fmt.Printf("cli:         %s\n", resolved.CLI)
		fmt.Printf("wrapper:     %s\n", resolved.Wrapper)
		if resolved.Provider != "" {
			fmt.Printf("provider:    %s\n", resolved.Provider)
		}
		if resolved.Model != "" {
			fmt.Printf("model:       %s\n", resolved.Model)
		}
		if resolved.Effort != "" {
			fmt.Printf("effort:      %s\n", resolved.Effort)
		}
		fmt.Printf("chrome:      %t\n", resolved.Chrome)
		fmt.Printf("headless:    %t\n", resolved.Headless)
		if resolved.ExtraFlags != "" {
			fmt.Printf("extra_flags: %s\n", resolved.ExtraFlags)
		}
		return nil
	},
}

func formatConstraints(a shuttle.AgentRecord) string {
	var parts []string
	if len(a.EffortLevels) > 0 {
		parts = append(parts, "effort="+strings.Join(a.EffortLevels, ","))
	}
	if a.ChromeCapable {
		parts = append(parts, "chrome")
	}
	if len(parts) == 0 {
		return ""
	}
	return "  [" + strings.Join(parts, " ") + "]"
}

func formatAlias(a shuttle.AgentRecord) string {
	if a.Axes == nil {
		return ""
	}
	var parts []string
	if a.Axes.Effort != "" {
		parts = append(parts, "effort="+a.Axes.Effort)
	}
	if a.Axes.Chrome {
		parts = append(parts, "chrome")
	}
	if a.Axes.Headless {
		parts = append(parts, "headless")
	}
	if len(parts) == 0 {
		return ""
	}
	return "  +[" + strings.Join(parts, " ") + "]"
}

func init() {
	shuttleAgentsResolveCmd.Flags().StringVar(&agentsResolveEffort, "effort", "",
		"Effort axis token (validated against the agent's effort_levels)")
	shuttleAgentsResolveCmd.Flags().BoolVar(&agentsResolveChrome, "chrome", false,
		"Enable the chrome axis (claude harness only)")
	shuttleAgentsCmd.AddCommand(shuttleAgentsResolveCmd)
	shuttleCmd.AddCommand(shuttleAgentsCmd)
}
