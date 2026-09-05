package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

// felt shuttle agents — the registry surface. felt owns the agent registry (the
// single source of truth); these verbs expose it so the networked daemon keeps
// zero registry knowledge of its own:
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
//   - `felt shuttle agents init` → seed the user registry file, so extending the
//     built-in set is a file to edit rather than a format to look up.
//
// The registry is the embedded built-ins with the user registry layered on top
// ($FELT_AGENTS_FILE, else ~/.config/felt/agents.json). Reads touch no felt
// store, so no -C / --felt-store context is required.

var (
	agentsResolveEffort string
	agentsResolveChrome bool
	agentsSourceFilter  string
	agentsInitPath      string
	agentsInitForce     bool
)

var shuttleAgentsCmd = &cobra.Command{
	Use:   "agents",
	Short: "List the agent registry felt owns (the single source of truth)",
	Long: `Print the effective agent registry — every base agent and alias with its
axis-constraint metadata (effort_levels, default_effort, chrome_capable).

The registry is the built-in set with the user registry layered on top
($FELT_AGENTS_FILE, else ~/.config/felt/agents.json). The table marks each
record — * default, u user-provided, blank built-in — and closes with a footer
on stderr naming what loaded from where. --source filters to one layer.

The user file defaults to builtins: "merge". Set builtins: "restrict" in its
envelope to make the listed records the complete registry for one host.

--json emits the bare array the daemon's GET /api/v1/agents serves to the
browser's agent picker, and nothing else: no footer, no warnings, either
stream.`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		switch agentsSourceFilter {
		case "", shuttle.SourceBuiltin, shuttle.SourceUser:
		default:
			return fmt.Errorf("--source must be %q or %q, got %q",
				shuttle.SourceBuiltin, shuttle.SourceUser, agentsSourceFilter)
		}

		reg, err := shuttle.LoadAgentRegistry()
		if err != nil {
			return fmt.Errorf("loading agent registry: %w", err)
		}

		records := reg.Records()
		if agentsSourceFilter != "" {
			filtered := make([]shuttle.AgentRecord, 0, len(records))
			for _, a := range records {
				if a.Source == agentsSourceFilter {
					filtered = append(filtered, a)
				}
			}
			records = filtered
		}

		// --json is a machine surface and stays silent apart from the array. Not
		// merely "stdout stays clean": the daemon shells this verb through
		// Shuttle.Felt.run, which always sets stderr_to_stdout (lib/shuttle/felt.ex),
		// so a footer on stderr would land inside the bytes it hands to
		// Jason.decode and empty the browser's agent picker. Provenance and
		// warnings are for a person reading a terminal — they ride the table.
		if jsonOutput {
			return outputJSON(records)
		}
		for _, w := range reg.Warnings() {
			fmt.Fprintf(cmd.ErrOrStderr(), "warning: %s\n", w)
		}
		for _, a := range records {
			if a.IsAlias() {
				fmt.Printf("%s %-22s → %s%s\n", sourceMarker(a), a.ID, a.AliasOf, formatAlias(a))
				continue
			}
			fmt.Printf("%s %-22s %-7s %-16s%s\n", sourceMarker(a), a.ID, a.CLI, a.Model, formatConstraints(a))
		}
		fmt.Fprintln(cmd.ErrOrStderr(), registryFooter(reg))
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

var shuttleAgentsInitCmd = &cobra.Command{
	Use:   "init",
	Short: "Write a user agent registry seeded from the built-ins",
	Long: `Seed the user agent registry with the built-in records, then edit it.

Writes $FELT_AGENTS_FILE (else ~/.config/felt/agents.json), or --path. Refuses
to overwrite an existing file without --force. The seeded file works every
field across several harnesses — edit it in place.`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		path := agentsInitPath
		if path == "" {
			p, err := shuttle.UserAgentsPath()
			if err != nil {
				return err
			}
			path = p
		}
		if _, err := os.Stat(path); err == nil && !agentsInitForce {
			return fmt.Errorf("%s already exists (use --force to overwrite)", path)
		}

		builtins, err := shuttle.LoadBuiltinAgentRegistry()
		if err != nil {
			return fmt.Errorf("loading built-in agent registry: %w", err)
		}
		// Provenance is the loader's, not the file's — a seeded record must not
		// claim to be a built-in once it lives in the user layer.
		records := append([]shuttle.AgentRecord{}, builtins.Records()...)
		for i := range records {
			records[i].Source = ""
		}
		payload, err := json.MarshalIndent(map[string]any{
			"version":  1,
			"builtins": shuttle.BuiltinsMerge,
			"agents":   records,
		}, "", "  ")
		if err != nil {
			return fmt.Errorf("encoding agent registry: %w", err)
		}

		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			return fmt.Errorf("creating %s: %w", filepath.Dir(path), err)
		}
		if err := os.WriteFile(path, append(payload, '\n'), 0644); err != nil {
			return fmt.Errorf("writing %s: %w", path, err)
		}
		fmt.Println(path)
		return nil
	},
}

// sourceMarker is the table's leading column: `*` the default agent, `u` a
// user-provided record, blank a built-in.
func sourceMarker(a shuttle.AgentRecord) string {
	switch {
	case a.Default:
		return "*"
	case a.Source == shuttle.SourceUser:
		return "u"
	default:
		return " "
	}
}

// registryFooter states what loaded from where — the answer to "did my file
// load?" without a second command. Stderr, so --json stdout stays parseable.
func registryFooter(reg *shuttle.AgentRegistry) string {
	total := len(reg.Records())
	if reg.UserPath() == "" {
		path, err := shuttle.UserAgentsPath()
		if err != nil {
			path = "~/.config/felt/agents.json"
		}
		return fmt.Sprintf("registry: %d builtin, no user file at %s → %d agents",
			reg.BuiltinCount(), path, total)
	}
	user := 0
	for _, a := range reg.Records() {
		if a.Source == shuttle.SourceUser {
			user++
		}
	}
	return fmt.Sprintf("registry: %d builtin + %d from %s (builtins: %s) → %d agents",
		reg.BuiltinCount(), user, reg.UserPath(), reg.BuiltinsMode(), total)
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
	shuttleAgentsCmd.Flags().StringVar(&agentsSourceFilter, "source", "",
		"Show only records from one layer: builtin | user")
	shuttleAgentsResolveCmd.Flags().StringVar(&agentsResolveEffort, "effort", "",
		"Effort axis token (validated against the agent's effort_levels)")
	shuttleAgentsResolveCmd.Flags().BoolVar(&agentsResolveChrome, "chrome", false,
		"Enable the chrome axis (claude harness only)")
	shuttleAgentsInitCmd.Flags().StringVar(&agentsInitPath, "path", "",
		"Write to this path instead of the default user registry location")
	shuttleAgentsInitCmd.Flags().BoolVar(&agentsInitForce, "force", false,
		"Overwrite an existing file")
	shuttleAgentsCmd.AddCommand(shuttleAgentsResolveCmd)
	shuttleAgentsCmd.AddCommand(shuttleAgentsInitCmd)
	shuttleCmd.AddCommand(shuttleAgentsCmd)
}
