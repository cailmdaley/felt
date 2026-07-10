package cmd

import (
	"bytes"
	_ "embed"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"text/template"

	"github.com/spf13/cobra"
)

// felt shuttle tunnels — laptop-side operator tooling that maps the remote
// Shuttle daemons onto local ports via launchd-managed autossh tunnels (so the
// daemon's owner-routing can reach candide:4001 / cineca:4002 over an SSH
// LocalForward). It is the typed setup command for the cross-host network; the
// running daemon owns the network at runtime, this just installs the plumbing.
//
// Ported from shuttle-ctl's tunnels verb in the shuttle->felt merge. The plist
// template is go:embed'd (like the agents registry) so there is no on-disk
// share/ lookup — the binary is self-contained.

//go:embed shuttle-tunnel.plist.tmpl
var tunnelPlistTemplate string

type tunnelSpec struct {
	Name        string
	LocalPort   int
	HoldCommand string
	// Multiplex: ride an existing ControlMaster socket (~/.ssh/ctl/%C, the
	// ssh-config ControlPath) instead of opening independent connections.
	// For hosts behind interactive 2FA (nibi's Duo) a fresh unattended ssh can
	// never authenticate, so the tunnel's only viable transport is the socket a
	// human-approved login left behind: alive → tunnel up for free; dead →
	// autossh retries harmlessly until the next approved `ssh <host>` login
	// revives the master, then the tunnel comes back on its own. Reuse-only —
	// ControlMaster stays "no" so a headless launchd job never tries (and
	// fails) to *create* a master.
	Multiplex bool
}

type tunnelTemplateData struct {
	Label       string
	SSHHost     string
	LocalPort   int
	HoldCommand string
	AutoSSHPath string
	SSHAuthSock string
	LogPath     string
	Home        string
	Multiplex   bool
}

var defaultTunnelSpecs = map[string]tunnelSpec{
	"candide":  {Name: "candide", LocalPort: 4001},
	"cineca":   {Name: "cineca", LocalPort: 4002},
	"amundsen": {Name: "amundsen", LocalPort: 4003},
	"nibi":     {Name: "nibi", LocalPort: 4004, Multiplex: true},
}

var (
	tunnelsPlistDir  string
	tunnelsLogDir    string
	tunnelsAutoSSH   string
	tunnelsWriteOnly bool
)

var tunnelsCmd = &cobra.Command{
	Use:   "tunnels",
	Short: "Install launchd-managed autossh tunnels for Shuttle remotes",
	Long: `Manage the laptop-side autossh tunnels that map remote Shuttle daemons
onto local ports. The generated plists are written into ~/Library/LaunchAgents
by default.

Examples:
  felt shuttle tunnels install              # candide + cineca + amundsen, write + bootstrap
  felt shuttle tunnels install candide      # only candide
  felt shuttle tunnels install --write-only # write plists but don't call launchctl`,
}

var tunnelsInstallCmd = &cobra.Command{
	Use:   "install [candide|cineca|amundsen ...]",
	Short: "Write and optionally bootstrap launchd plists for Shuttle tunnels",
	Args:  cobra.ArbitraryArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		return installTunnels(args)
	},
}

func installTunnels(requested []string) error {
	specs, err := resolveTunnelSpecs(requested)
	if err != nil {
		return err
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("resolve home dir: %w", err)
	}
	plistDir := tunnelsPlistDir
	if plistDir == "" {
		plistDir = filepath.Join(home, "Library", "LaunchAgents")
	}
	logDir := tunnelsLogDir
	if logDir == "" {
		logDir = filepath.Join(home, ".local", "state", "shuttle")
	}

	autosshPath := tunnelsAutoSSH
	if autosshPath == "" {
		autosshPath, err = exec.LookPath("autossh")
		if err != nil {
			return fmt.Errorf("autossh not found on PATH (install with `brew install autossh` or pass --autossh-path)")
		}
	}

	if err := os.MkdirAll(plistDir, 0o755); err != nil {
		return fmt.Errorf("create plist dir %s: %w", plistDir, err)
	}
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		return fmt.Errorf("create log dir %s: %w", logDir, err)
	}

	tmpl, err := template.New("shuttle-tunnel").Parse(tunnelPlistTemplate)
	if err != nil {
		return fmt.Errorf("parse embedded tunnel template: %w", err)
	}

	uid := os.Getuid()
	for _, spec := range specs {
		label := tunnelLabel(spec.Name)
		plistPath := filepath.Join(plistDir, label+".plist")
		logPath := filepath.Join(logDir, fmt.Sprintf("tunnel-%s.log", spec.Name))

		rendered, err := renderTunnelPlist(tmpl, tunnelTemplateData{
			Label:       label,
			SSHHost:     spec.Name,
			LocalPort:   spec.LocalPort,
			HoldCommand: spec.HoldCommand,
			Multiplex:   spec.Multiplex,
			AutoSSHPath: autosshPath,
			SSHAuthSock: os.Getenv("SSH_AUTH_SOCK"),
			LogPath:     logPath,
			Home:        home,
		})
		if err != nil {
			return fmt.Errorf("render %s: %w", label, err)
		}
		if err := os.WriteFile(plistPath, rendered, 0o644); err != nil {
			return fmt.Errorf("write %s: %w", plistPath, err)
		}

		fmt.Printf("installed %s -> %s\n", label, plistPath)
		fmt.Printf("  log: %s\n", logPath)

		if tunnelsWriteOnly {
			continue
		}

		target := fmt.Sprintf("gui/%d/%s", uid, label)
		_ = runLaunchctl("bootout", target)
		if err := runLaunchctl("bootstrap", fmt.Sprintf("gui/%d", uid), plistPath); err != nil {
			return fmt.Errorf("bootstrap %s: %w", label, err)
		}
		if err := runLaunchctl("kickstart", "-k", target); err != nil {
			return fmt.Errorf("kickstart %s: %w", label, err)
		}
		fmt.Printf("  bootstrapped %s\n", target)
	}

	return nil
}

func resolveTunnelSpecs(requested []string) ([]tunnelSpec, error) {
	if len(requested) == 0 {
		names := make([]string, 0, len(defaultTunnelSpecs))
		for name := range defaultTunnelSpecs {
			names = append(names, name)
		}
		sort.Strings(names)
		resolved := make([]tunnelSpec, 0, len(names))
		for _, name := range names {
			resolved = append(resolved, defaultTunnelSpecs[name])
		}
		return resolved, nil
	}

	resolved := make([]tunnelSpec, 0, len(requested))
	seen := map[string]bool{}
	for _, name := range requested {
		spec, ok := defaultTunnelSpecs[name]
		if !ok {
			return nil, fmt.Errorf("unknown tunnel %q (supported: candide, cineca, amundsen)", name)
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		resolved = append(resolved, spec)
	}
	sort.Slice(resolved, func(i, j int) bool { return resolved[i].Name < resolved[j].Name })
	return resolved, nil
}

func renderTunnelPlist(tmpl *template.Template, data tunnelTemplateData) ([]byte, error) {
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, data); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func tunnelLabel(name string) string {
	return fmt.Sprintf("com.cailmdaley.shuttle-tunnel-%s", name)
}

func runLaunchctl(args ...string) error {
	cmd := exec.Command("launchctl", args...)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	msg := string(bytes.TrimSpace(out))
	if msg == "" {
		msg = err.Error()
	}
	return fmt.Errorf("launchctl %v: %s", args, msg)
}

func init() {
	tunnelsInstallCmd.Flags().StringVar(&tunnelsPlistDir, "plist-dir", "", "Directory to write launchd plists into (default: ~/Library/LaunchAgents)")
	tunnelsInstallCmd.Flags().StringVar(&tunnelsLogDir, "log-dir", "", "Directory for autossh logs (default: ~/.local/state/shuttle)")
	tunnelsInstallCmd.Flags().StringVar(&tunnelsAutoSSH, "autossh-path", "", "Path to autossh (default: resolve on PATH)")
	tunnelsInstallCmd.Flags().BoolVar(&tunnelsWriteOnly, "write-only", false, "Write plist files but do not call launchctl bootstrap/kickstart")
	tunnelsCmd.AddCommand(tunnelsInstallCmd)
	shuttleCmd.AddCommand(tunnelsCmd)
}
