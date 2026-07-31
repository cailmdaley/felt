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

// felt shuttle tunnels — hub-side operator tooling that maps the remote Shuttle
// daemons onto local ports via launchd-managed autossh tunnels (so the daemon's
// owner-routing can reach a remote's :4000 over an SSH LocalForward). It is the
// typed setup command for the cross-host network; the running daemon owns the
// network at runtime, this just installs the plumbing.
//
// The fleet itself is NOT described here. Every name, port, and tunnel option
// comes from the shared fleet file (see shuttle_remotes.go), which the Elixir
// daemon reads too — so the plist a tunnel is installed as and the launchd label
// the recovery cascade kickstarts cannot drift.
//
// Ported from shuttle-ctl's tunnels verb in the shuttle->felt merge. The plist
// template is go:embed'd (like the agents registry) so there is no on-disk
// share/ lookup — the binary is self-contained.

//go:embed shuttle-tunnel.plist.tmpl
var tunnelPlistTemplate string

type tunnelSpec struct {
	Name        string
	SSHHost     string
	Label       string
	LocalPort   int
	RemotePort  int
	HoldCommand string
	// Multiplex: ride an existing ControlMaster socket (~/.ssh/ctl/%C, the
	// ssh-config ControlPath) instead of opening independent connections.
	// For a host behind interactive 2FA a fresh unattended ssh can never
	// authenticate, so the tunnel's only viable transport is the socket a
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
	RemotePort  int
	HoldCommand string
	AutoSSHPath string
	SSHAuthSock string
	LogPath     string
	Home        string
	Multiplex   bool
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
	Long: `Manage the hub-side autossh tunnels that map remote Shuttle daemons
onto local ports. The generated plists are written into ~/Library/LaunchAgents
by default.

The remotes come from the fleet file (` + "`felt shuttle remotes path`" + `).

Examples:
  felt shuttle tunnels install              # every configured remote, write + bootstrap
  felt shuttle tunnels install <name>       # only that remote
  felt shuttle tunnels install --write-only # write plists but don't call launchctl`,
}

var tunnelsInstallCmd = &cobra.Command{
	Use:   "install [name ...]",
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
		label := spec.Label
		plistPath := filepath.Join(plistDir, label+".plist")
		logPath := filepath.Join(logDir, fmt.Sprintf("tunnel-%s.log", spec.Name))

		rendered, err := renderTunnelPlist(tmpl, tunnelTemplateData{
			Label:       label,
			SSHHost:     spec.SSHHost,
			LocalPort:   spec.LocalPort,
			RemotePort:  spec.RemotePort,
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

// resolveTunnelSpecs turns the configured fleet into the tunnels to install.
//
// With no arguments it is every enabled remote whose tunnel manager is launchd.
// With arguments it is exactly those remotes, and an unknown one is an error
// that names what IS configured — the fleet lives in one file, so the error can
// always be specific.
func resolveTunnelSpecs(requested []string) ([]tunnelSpec, error) {
	doc, err := loadRemotesFile()
	if err != nil {
		return nil, err
	}

	byName := make(map[string]remoteSpec, len(doc.Remotes))
	for _, r := range doc.Remotes {
		byName[r.Name] = r
	}

	toSpec := func(r remoteSpec) tunnelSpec {
		return tunnelSpec{
			Name:       r.Name,
			SSHHost:    r.SSH,
			Label:      r.label(doc.LaunchdLabelPrefix),
			LocalPort:  r.Port,
			RemotePort: r.RemotePort,
			Multiplex:  r.tunnelOpts().Multiplex,
		}
	}

	if len(requested) == 0 {
		if len(doc.Remotes) == 0 {
			path, _ := feltRemotesPath()
			return nil, fmt.Errorf(
				"no remotes configured; run 'felt shuttle remotes add <name> --port <n>' (file: %s)", path)
		}
		resolved := make([]tunnelSpec, 0, len(doc.Remotes))
		for _, r := range doc.Remotes {
			if !r.enabledOr() || r.tunnelOpts().Manager != "launchd" {
				continue
			}
			resolved = append(resolved, toSpec(r))
		}
		if len(resolved) == 0 {
			return nil, fmt.Errorf("no remotes use launchd-managed tunnels (configured: %s)",
				remoteNameList(doc.Remotes))
		}
		sort.Slice(resolved, func(i, j int) bool { return resolved[i].Name < resolved[j].Name })
		return resolved, nil
	}

	resolved := make([]tunnelSpec, 0, len(requested))
	seen := map[string]bool{}
	for _, name := range requested {
		r, ok := byName[name]
		if !ok {
			return nil, fmt.Errorf("unknown tunnel %q (configured: %s)", name, remoteNameList(doc.Remotes))
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		resolved = append(resolved, toSpec(r))
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
