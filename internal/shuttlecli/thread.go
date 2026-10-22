package shuttlecli

import (
	"fmt"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/spf13/cobra"
)

func (a *app) threadCmd() *cobra.Command {
	var host, agent, projectDir, role, slug, surface string
	var disabled bool
	cmd := &cobra.Command{
		Use:   `thread <parent> "<ask>"`,
		Short: "Create and install a child constitution",
		Long: `Create a thread under a constitution and print its new fiber id.
The ask becomes its name and lede, followed by empty Desired State and Status
sections. Host, project_dir, role, agent and execution surface inherit from the
parent unless explicitly overridden. Threads are armed (status: active) unless --disabled.

Changing --host requires an explicit --project-dir, even for a draft: paths on
different machines are not interchangeable. Inherited paths are kept verbatim;
explicit paths use install's local directory validation (run on the destination
host when its path is not available here). Runtime, schedule and seat do not
inherit. An absent parent surface means CLI. Inherited app execution falls back
to CLI when the selected agent is not Codex. --surface cli|app overrides inheritance;
app requires a Codex agent. Invalid selections never create or arm a child.

--json prints an object with the new id. No daemon is needed.`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			ask := strings.TrimSpace(args[1])
			if ask == "" {
				return fmt.Errorf("ask must not be empty")
			}
			parent, st, err := a.shuttleResolveFiber(args[0], true)
			if err != nil {
				return err
			}
			parent, unlock, err := lockAndReloadFiber(st, parent)
			if err != nil {
				return err
			}
			defer unlock()
			inherited, ok, err := shuttle.BlockOf(parent)
			if err != nil {
				return err
			}
			if !ok {
				return fmt.Errorf("parent %s has no shuttle: block", parent.ID)
			}
			block := &shuttle.Block{Kind: "oneshot", Host: inherited.Host, ProjectDir: inherited.ProjectDir, Role: inherited.Role, Agent: inherited.Agent}
			if cmd.Flags().Changed("host") {
				block.Host = host
				if host != inherited.Host && !cmd.Flags().Changed("project-dir") {
					return fmt.Errorf("changing host requires --project-dir; the parent's path belongs to %s", inherited.Host)
				}
			}
			if cmd.Flags().Changed("agent") {
				block.Agent = agent
			}
			if cmd.Flags().Changed("role") {
				block.Role = role
			}
			if cmd.Flags().Changed("project-dir") {
				block.ProjectDir, err = a.resolveProjectDirFlag(projectDir)
				if err != nil {
					return err
				}
			}
			if !disabled && block.ProjectDir == "" {
				return fmt.Errorf("armed thread requires --project-dir or a parent project_dir")
			}
			reg, err := shuttle.LoadAgentRegistry(a.env)
			if err != nil {
				return err
			}
			block.Surface = inherited.Surface
			if block.Surface == "" {
				block.Surface = "cli"
			}
			if cmd.Flags().Changed("surface") {
				if surface != "cli" && surface != "app" {
					return fmt.Errorf("--surface must be cli or app")
				}
				block.Surface = surface
			} else if block.Surface == "app" {
				name := block.Agent
				if name == "" {
					def, err := reg.Default()
					if err != nil {
						return err
					}
					name = def.ID
				}
				base, _, err := reg.Resolve(name, block.Effort, block.Chrome)
				if err != nil {
					return err
				}
				if base.CLI != "codex" {
					block.Surface = "cli"
				}
			}
			if errs := shuttle.Validate(block, reg); len(errs) > 0 {
				return a.printShuttleValidationErrors(errs)
			}
			if !cmd.Flags().Changed("slug") {
				slug, err = felt.GenerateID(ask)
			}
			if err != nil {
				return err
			}
			if slug == "" || strings.ContainsAny(slug, `/\\`) || slug == "." || slug == ".." {
				return fmt.Errorf("--slug must name one child, not a path")
			}
			child, err := felt.New(parent.ID+"/"+slug, ask)
			if err != nil {
				return err
			}
			childUnlock, err := st.LockFiber(child.ID)
			if err != nil {
				return err
			}
			defer childUnlock()
			if err := st.CheckAvailableID(child.ID); err != nil {
				return err
			}
			child.Body = ask + "\n\n## Desired State\n\n## Status\n"
			child.AddTag("constitution")
			child.Status = felt.StatusActive
			if disabled {
				child.Status = felt.StatusOpen
			}
			if err := shuttle.SetConfig(child, block); err != nil {
				return err
			}
			child.Touch(child.CreatedAt)
			if err := st.Write(child); err != nil {
				return err
			}
			if a.json {
				return a.outputJSON(map[string]string{"id": child.ID})
			}
			fmt.Fprintln(a.env.Stdout, child.ID)
			return nil
		},
	}
	cmd.Flags().StringVar(&host, "host", "", "Owning daemon (default: parent's host)")
	cmd.Flags().StringVar(&agent, "agent", "", "Agent id (default: parent's agent)")
	cmd.Flags().StringVar(&surface, "surface", "", "Execution surface: cli or app (default: compatible parent surface)")
	cmd.Flags().StringVar(&projectDir, "project-dir", "", "Worker cwd; required when changing host")
	cmd.Flags().StringVar(&role, "role", "", "Role slug (default: parent's role)")
	cmd.Flags().StringVar(&slug, "slug", "", "Child slug (default: derived from ask)")
	cmd.Flags().BoolVar(&disabled, "disabled", false, "Create a draft instead of arming it")
	return cmd
}
